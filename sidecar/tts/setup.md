# Piper TTS Setup

Piper is a fast, local neural text-to-speech system. Dash uses it to give the AI a voice.

## Install

```bash
pip install piper-tts
```

## Test manually

```bash
# Start the HTTP server (first run downloads the voice model ~100MB)
python -m piper.http_server --model en_US-lessac-medium --port 3579

# In another terminal, synthesize speech
curl "http://127.0.0.1:3579/?text=Hello+from+Dash" --output test.wav
```

Play `test.wav` to verify it sounds correct.

## How Dash uses it

When Dash starts, it automatically spawns the Piper HTTP server as a sidecar process. The voice model and port are configured in `brain/settings.json` under the `tts` key:

```json
{
  "tts": {
    "enabled": true,
    "port": 3579,
    "voice": "en_US-lessac-medium",
    "autoPlay": true
  }
}
```

Set `"enabled": false` to disable TTS entirely.

## Available voices

Browse voices at: https://rhasspy.github.io/piper-samples/

Change the voice in settings — Piper downloads the model automatically on first use.
