# Whisper STT Setup

Dash uses whisper.cpp's HTTP server for local speech-to-text transcription.

## Install

### 1. Download whisper-server

Get the latest release from: https://github.com/ggerganov/whisper.cpp/releases

- **Windows**: Download the `whisper-server.exe` binary
- **macOS/Linux**: Download or build `whisper-server`

Place the binary in this directory:
```
sidecar/stt/whisper-server.exe    (Windows)
sidecar/stt/whisper-server        (macOS/Linux)
```

### 2. Download a model

```bash
# Base English model (~150MB, good balance of speed and accuracy)
curl -L -o sidecar/stt/models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

Other model sizes: `tiny.en` (fast, less accurate), `small.en` (slower, more accurate), `medium.en` (slowest, most accurate).

## Test manually

```bash
cd sidecar/stt
./whisper-server -m models/ggml-base.en.bin --port 3580 --host 127.0.0.1

# In another terminal, transcribe an audio file
curl -F "file=@test.wav" http://127.0.0.1:3580/inference
```

## How Dash uses it

Dash auto-spawns whisper-server as a sidecar. Configure in `brain/settings.json`:

```json
{
  "stt": {
    "enabled": true,
    "port": 3580,
    "model": "ggml-base.en.bin"
  }
}
```

Set `"enabled": false` to disable STT entirely.
