# MuseTalk Avatar Sidecar — Setup

## Prerequisites

- NVIDIA GPU with 12+ GB VRAM (tested on RTX 3060/4070+)
- CUDA 11.8+ installed
- FFmpeg on PATH (`ffmpeg -version` should work)
- Python 3.10+ (conda recommended)

## Step 1: Clone MuseTalk

```bash
cd E:\
git clone https://github.com/TMElyralab/MuseTalk.git musetalk
cd musetalk
```

## Step 2: Create conda environment

```bash
conda create -n musetalk python=3.10 -y
conda activate musetalk
```

## Step 3: Install PyTorch + CUDA

```bash
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118
```

## Step 4: Install MMLab stack

```bash
pip install mmcv==2.1.0 -f https://download.openmmlab.com/mmcv/dist/cu118/torch2.1/index.html
pip install mmdet==3.2.0 mmpose==1.3.1
```

## Step 5: Install MuseTalk dependencies

```bash
cd C:\AI\MuseTalk
pip install -r requirements.txt
```

## Step 6: Download models (~1.9GB)

Follow MuseTalk's README to download:
- `models/musetalk/musetalk.json` + `pytorch_model.bin` (UNet)
- `models/sd-vae-ft-mse/` (VAE)
- `models/whisper/tiny.pt` (audio feature extraction)
- `models/dwpose/` (face landmark detection)
- `models/face-parse-bisent/` (face segmentation mask)

Or use their download script if available.

## Step 7: Install sidecar dependencies

```bash
conda activate musetalk
cd E:\Dash\sidecar\avatar
pip install -r requirements.txt
```

## Step 8: Configure Dash settings

Edit `brain/settings.json` and add:

```json
{
  "avatar": {
    "enabled": true,
    "port": 3581,
    "musetalkPath": "C:\\AI\\MuseTalk",
    "photoPath": "public/avatar/photo.png"
  }
}
```

## Step 9: Add your reference photo

Place a clear, front-facing photo at `public/avatar/photo.png`. Tips:
- Face should be centered and well-lit
- Neutral expression works best
- Resolution ~512x512 or larger
- PNG or JPG format

## Step 10: Test

```bash
# Start sidecar manually to test
conda activate musetalk
python sidecar/avatar/server.py --port 3581 --musetalk-path "C:\AI\MuseTalk"

# In another terminal:
curl http://localhost:3581/health
# → {"status":"ok","ready":true}

# Prepare photo:
curl -F "photo=@public/avatar/photo.png" http://localhost:3581/prepare
# → {"ok":true,"cached":false}

# Generate video (needs a WAV file):
curl -F "audio=@test.wav" http://localhost:3581/generate --output test.mp4
# → test.mp4 should be a valid video with lip-synced face
```

## Troubleshooting

- **CUDA out of memory**: Reduce batch_size in server.py (default 4)
- **No face detected**: Ensure photo has a clear, visible face
- **FFmpeg not found**: Install FFmpeg and add to PATH
- **Import errors**: Make sure `--musetalk-path` points to the MuseTalk repo root
- **Slow first run**: Model loading takes 30-60s on first startup, subsequent starts use cached weights
