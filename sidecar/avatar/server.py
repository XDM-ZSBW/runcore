"""
MuseTalk avatar sidecar — FastAPI server wrapping MuseTalk for audio-driven lip-sync.

Endpoints:
  GET  /health   → { status: "ok", ready: bool }
  POST /prepare  → accepts photo, runs one-time preprocessing, caches to disk
  POST /generate → accepts WAV upload, returns MP4 (video+audio muxed via FFmpeg)
"""

import argparse
import copy
import hashlib
import os
import pickle
import subprocess
import sys
import tempfile
import time
from pathlib import Path

# Force UTF-8 mode on Windows before anything else touches I/O
if sys.platform == "win32":
    os.environ["PYTHONUTF8"] = "1"
    os.environ["PYTHONIOENCODING"] = "utf-8"
    # Replace stdout/stderr with UTF-8 streams that replace unencodable chars
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

import cv2
import numpy as np
import torch
import uvicorn
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse, Response

# --- Globals ---

app = FastAPI(title="MuseTalk Avatar Sidecar")
musetalk_path: str = ""
models_loaded = False
ready = False

# Model references (loaded once on startup)
audio_processor = None  # whisper audio feature extractor (Audio2Feature)
vae = None
unet = None
pe = None   # positional encoding
fp = None   # face parsing model
timesteps = None
device = None

# Preprocessing cache (per reference photo)
coord_list_cycle = None
frame_list_cycle = None
input_latent_list_cycle = None
mask_coords_list_cycle = None
mask_list_cycle = None
photo_hash = None

BATCH_SIZE = 4


def add_musetalk_to_path():
    """Add MuseTalk to sys.path so its modules can be imported."""
    global musetalk_path
    if musetalk_path and musetalk_path not in sys.path:
        sys.path.insert(0, musetalk_path)


def load_models():
    """Load all MuseTalk models once on startup (~3.6GB VRAM)."""
    global models_loaded, audio_processor, vae, unet, pe, fp, timesteps, device, ready

    add_musetalk_to_path()

    try:
        from musetalk.whisper.audio2feature import Audio2Feature
        from musetalk.utils.utils import load_all_model
        from musetalk.utils.face_parsing import FaceParsing

        print("[avatar] Loading models...")
        start = time.time()

        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

        # Audio feature extractor (whisper tiny)
        audio_processor = Audio2Feature(model_path="tiny")

        # VAE + UNet + PositionalEncoding
        vae, unet, pe = load_all_model(device=device)

        # Half precision for speed
        pe = pe.half().to(device)
        vae.vae = vae.vae.half().to(device)
        unet.model = unet.model.half().to(device)

        timesteps = torch.tensor([0], device=device)

        # Face parsing for blending masks
        fp = FaceParsing()

        elapsed = time.time() - start
        print(f"[avatar] Models loaded in {elapsed:.1f}s")
        print(f"[avatar] VRAM: {torch.cuda.memory_allocated()/1024**3:.2f} GB")
        models_loaded = True
        ready = True
    except Exception as e:
        print(f"[avatar] Failed to load models: {e}")
        import traceback
        traceback.print_exc()
        models_loaded = False
        ready = False


@app.get("/health")
async def health():
    return {"status": "ok", "ready": ready}


def _run_landmark_subprocess(img_path: str, musetalk_dir: str) -> tuple:
    """Run get_landmark_and_bbox in a subprocess to isolate encoding issues.

    Returns (coord_list, frame_list) via pickle written to a temp file.
    The subprocess has clean UTF-8 I/O, avoiding uvicorn's encoding context.
    """
    # Use a temp file for the result — subprocess stdout is contaminated by
    # MuseTalk's print statements (model loading, tqdm, Chinese log messages)
    result_fd, result_path = tempfile.mkstemp(suffix=".pkl")
    os.close(result_fd)

    script = '''
import sys, os, pickle
os.environ["PYTHONUTF8"] = "1"
sys.path.insert(0, sys.argv[1])
os.chdir(sys.argv[1])
from musetalk.utils.preprocessing import get_landmark_and_bbox
coord_list, frame_list = get_landmark_and_bbox([sys.argv[2]], upperbondrange=0)
with open(sys.argv[3], "wb") as f:
    pickle.dump((coord_list, frame_list), f, protocol=4)
'''
    try:
        result = subprocess.run(
            [sys.executable, "-c", script, musetalk_dir, img_path, result_path],
            capture_output=True,
            timeout=120,
            env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
        )
        if result.returncode != 0:
            stderr_text = result.stderr.decode(errors="replace")
            raise RuntimeError(f"Landmark subprocess failed: {stderr_text[:1000]}")

        with open(result_path, "rb") as f:
            coord_list, frame_list = pickle.load(f)
        return coord_list, frame_list
    finally:
        try:
            os.unlink(result_path)
        except OSError:
            pass


@app.post("/prepare")
async def prepare(photo: UploadFile = File(...)):
    """Run one-time preprocessing on the reference photo."""
    global coord_list_cycle, frame_list_cycle, input_latent_list_cycle
    global mask_coords_list_cycle, mask_list_cycle, photo_hash

    if not models_loaded:
        return JSONResponse({"error": "Models not loaded"}, status_code=503)

    add_musetalk_to_path()

    try:
        from musetalk.utils.blending import get_image_prepare_material

        # Read photo bytes
        photo_bytes = await photo.read()
        new_hash = hashlib.sha256(photo_bytes).hexdigest()

        # Skip if same photo already prepared
        if new_hash == photo_hash and coord_list_cycle is not None:
            return {"ok": True, "cached": True}

        # Write to temp file (get_landmark_and_bbox takes file paths)
        suffix = Path(photo.filename or "photo.png").suffix or ".png"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False, dir=".") as tmp:
            tmp.write(photo_bytes)
            tmp_path = tmp.name

        try:
            print(f"[avatar] Preprocessing photo ({len(photo_bytes)} bytes)...")
            start = time.time()

            # Run face detection in a subprocess to avoid Windows encoding errors
            # (MuseTalk's Chinese log messages + tqdm crash under uvicorn's I/O)
            coord_list, frame_list = _run_landmark_subprocess(tmp_path, musetalk_path)

            coord_placeholder = (0.0, 0.0, 0.0, 0.0)
            if not coord_list or coord_list[0] == coord_placeholder:
                return JSONResponse({"error": "No face detected in photo"}, status_code=400)

            # VAE encode each frame's face crop → latents
            input_latent_list = []
            for bbox, frame in zip(coord_list, frame_list):
                if bbox == coord_placeholder:
                    continue
                x1, y1, x2, y2 = bbox
                crop = frame[y1:y2, x1:x2]
                resized = cv2.resize(crop, (256, 256), interpolation=cv2.INTER_LANCZOS4)
                latents = vae.get_latents_for_unet(resized)
                input_latent_list.append(latents)

            if not input_latent_list:
                return JSONResponse({"error": "Face crop failed"}, status_code=400)

            # Build cycle lists (forward + reverse for smooth looping)
            _frame_cycle = frame_list + frame_list[::-1]
            _coord_cycle = coord_list + coord_list[::-1]
            _latent_cycle = input_latent_list + input_latent_list[::-1]

            # Compute blending masks for each frame in cycle
            _mask_list = []
            _mask_coords = []
            for i, frame in enumerate(_frame_cycle):
                x1, y1, x2, y2 = _coord_cycle[i]
                mask, crop_box = get_image_prepare_material(
                    frame, [x1, y1, x2, y2], fp=fp, mode="raw"
                )
                _mask_list.append(mask)
                _mask_coords.append(crop_box)

            # Store results
            coord_list_cycle = _coord_cycle
            frame_list_cycle = _frame_cycle
            input_latent_list_cycle = _latent_cycle
            mask_list_cycle = _mask_list
            mask_coords_list_cycle = _mask_coords
            photo_hash = new_hash

            elapsed = time.time() - start
            print(f"[avatar] Photo preprocessed in {elapsed:.1f}s")
            return {"ok": True, "cached": False}

        finally:
            os.unlink(tmp_path)

    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        return JSONResponse({"error": str(e), "traceback": tb}, status_code=500)


@app.post("/generate")
async def generate(audio: UploadFile = File(...)):
    """Generate lip-synced video from WAV audio. Returns MP4 with muxed audio."""
    if not models_loaded or not ready:
        return JSONResponse({"error": "Not ready"}, status_code=503)

    if coord_list_cycle is None:
        return JSONResponse({"error": "No photo prepared — call /prepare first"}, status_code=400)

    add_musetalk_to_path()

    try:
        from musetalk.utils.utils import datagen
        from musetalk.utils.blending import get_image_blending

        # Write audio to temp file
        audio_bytes = await audio.read()
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_wav:
            tmp_wav.write(audio_bytes)
            wav_path = tmp_wav.name

        tmp_video_fd, tmp_video_path = tempfile.mkstemp(suffix=".mp4")
        os.close(tmp_video_fd)
        tmp_muxed_fd, tmp_muxed_path = tempfile.mkstemp(suffix=".mp4")
        os.close(tmp_muxed_fd)

        try:
            print(f"[avatar] Generating from {len(audio_bytes)} bytes of audio...")
            gen_start = time.time()

            # Extract audio features → whisper chunks (one per video frame at 25fps)
            whisper_feature = audio_processor.audio2feat(wav_path)
            whisper_chunks = audio_processor.feature2chunks(
                feature_array=whisper_feature, fps=25
            )

            # feature2chunks returns numpy arrays — datagen needs tensors
            whisper_chunks = [torch.from_numpy(c).float() for c in whisper_chunks]

            num_frames = len(whisper_chunks)
            if num_frames == 0:
                return JSONResponse({"error": "No audio frames extracted"}, status_code=400)

            # Video writer
            h, w = frame_list_cycle[0].shape[:2]
            fourcc = cv2.VideoWriter_fourcc(*"mp4v")
            out_writer = cv2.VideoWriter(tmp_video_path, fourcc, 25, (w, h))

            # Generate frames in batches via datagen
            gen = datagen(whisper_chunks, input_latent_list_cycle, BATCH_SIZE)
            frame_idx = 0
            coord_placeholder = (0.0, 0.0, 0.0, 0.0)

            for whisper_batch, latent_batch in gen:
                # Positional encoding on audio features (pe is half precision)
                audio_feat = pe(whisper_batch.to(device=device).half())
                latent_batch = latent_batch.to(device=device, dtype=unet.model.dtype)

                # Single-step UNet inference
                pred_latents = unet.model(
                    latent_batch,
                    timesteps,
                    encoder_hidden_states=audio_feat,
                ).sample

                # Decode to face images
                pred_latents = pred_latents.to(device=device, dtype=vae.vae.dtype)
                recon = vae.decode_latents(pred_latents)

                for res_frame in recon:
                    if frame_idx >= num_frames:
                        break

                    bbox = coord_list_cycle[frame_idx % len(coord_list_cycle)]
                    ori_frame = copy.deepcopy(
                        frame_list_cycle[frame_idx % len(frame_list_cycle)]
                    )

                    if bbox == coord_placeholder:
                        out_writer.write(ori_frame)
                        frame_idx += 1
                        continue

                    x1, y1, x2, y2 = bbox
                    res_frame = cv2.resize(
                        res_frame.astype(np.uint8), (x2 - x1, y2 - y1)
                    )

                    mask = mask_list_cycle[frame_idx % len(mask_list_cycle)]
                    mask_crop_box = mask_coords_list_cycle[
                        frame_idx % len(mask_coords_list_cycle)
                    ]

                    combined = get_image_blending(
                        ori_frame, res_frame, bbox, mask, mask_crop_box
                    )
                    out_writer.write(combined)
                    frame_idx += 1

            out_writer.release()

            # Mux video + audio with FFmpeg
            ffmpeg_cmd = [
                "ffmpeg", "-y",
                "-i", tmp_video_path,
                "-i", wav_path,
                "-c:v", "libx264",
                "-preset", "ultrafast",
                "-crf", "23",
                "-c:a", "aac",
                "-b:a", "128k",
                "-shortest",
                "-movflags", "+faststart",
                tmp_muxed_path,
            ]

            result = subprocess.run(ffmpeg_cmd, capture_output=True, timeout=120)

            if result.returncode != 0:
                stderr = result.stderr.decode(errors="replace")
                print(f"[avatar] FFmpeg failed: {stderr[:500]}")
                return JSONResponse({"error": "FFmpeg muxing failed"}, status_code=500)

            with open(tmp_muxed_path, "rb") as f:
                mp4_bytes = f.read()

            elapsed = time.time() - gen_start
            print(f"[avatar] Generated {frame_idx} frames in {elapsed:.1f}s")

            return Response(
                content=mp4_bytes,
                media_type="video/mp4",
                headers={"Content-Length": str(len(mp4_bytes))},
            )

        finally:
            for p in [wav_path, tmp_video_path, tmp_muxed_path]:
                try:
                    os.unlink(p)
                except OSError:
                    pass

    except Exception as e:
        print(f"[avatar] Generate failed: {e}")
        import traceback
        traceback.print_exc()
        return JSONResponse({"error": str(e)}, status_code=500)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="MuseTalk Avatar Sidecar")
    parser.add_argument("--port", type=int, default=3581)
    parser.add_argument("--musetalk-path", type=str, required=True,
                        help="Absolute path to MuseTalk clone directory")
    args = parser.parse_args()

    musetalk_path = args.musetalk_path
    print(f"[avatar] MuseTalk path: {musetalk_path}")
    print(f"[avatar] Starting on port {args.port}")

    # MuseTalk uses relative paths for config files — must run from its directory
    os.chdir(musetalk_path)
    print(f"[avatar] Working directory: {os.getcwd()}")

    load_models()

    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
