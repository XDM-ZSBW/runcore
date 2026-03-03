# Core Avatar

Place a GLB avatar model here as `dash.glb` to enable the 3D TalkingHead avatar.

## How it works

Core uses [TalkingHead.js](https://github.com/met4citizen/TalkingHead) to render a 3D avatar in the chat UI. When Piper TTS speaks, the audio drives lip-sync animations on the model.

If no `dash.glb` file is found, Core falls back to a CSS-animated placeholder.

## Getting a compatible model

The GLB model needs:
- **Mixamo-compatible skeleton rig** (standard humanoid bone names)
- **52 ARKit blend shapes** (eyeBlinkLeft, jawOpen, mouthSmile, etc.)
- **15 Oculus viseme blend shapes** (viseme_sil, viseme_PP, viseme_FF, etc.)

### Option 1: Avaturn (recommended, free)

1. Go to [avaturn.me](https://avaturn.me/)
2. Create an avatar (photo upload or customize)
3. Export as GLB with ARKit blend shapes enabled
4. Save as `public/avatar/dash.glb`

### Option 2: MPFB (Blender, free)

1. Install [MPFB](https://static.makehumancommunity.org/mpfb.html) Blender extension
2. Create a character, export as GLB
3. Use the TalkingHead [build-visemes-from-arkit.py](https://github.com/met4citizen/TalkingHead/blob/main/blender/build-visemes-from-arkit.py) Blender script to add Oculus visemes from ARKit shapes
4. Save as `public/avatar/dash.glb`

### Option 3: Any GLB with the right blend shapes

Any GLB/GLTF model with the required blend shapes will work. The model is loaded via Three.js at `/public/avatar/dash.glb`.

## Customization

The avatar initialization is in the `<script type="module">` block at the bottom of `public/index.html`. You can adjust:

- `cameraView`: `"full"`, `"mid"`, `"upper"`, `"head"`
- `avatarMood`: `"neutral"`, `"happy"`, `"angry"`, `"sad"`, `"love"`, etc.
- `body`: `"M"` or `"F"` (affects idle animation style)
- Lighting: ambient/direct color and intensity
