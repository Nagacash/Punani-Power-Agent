# Video Reel

Create social media reels and showreels from raw footage with automatic captioning, B-roll, motion graphics, and music synchronization.

## When to use
- User has raw footage and wants a polished social media reel
- Need automatic caption generation and burning
- Want motion graphics cards overlaid on the video
- Need background music with beat-synchronized cuts
- Building a professional showreel or portfolio video

## Triggers
- "make a reel from"
- "create a showreel"
- "edit this into a video"
- "turn footage into"
- "create social media video"
- "build a highlight reel"

## Allowed Tools
- `bash` - for running ffmpeg operations, ffprobe analysis
- `read` - for reading transcripts and timing data
- `write` - for saving output video and assets
- `audio` - for generating/additional narration (ElevenLabs)
- `image` - for generating motion graphics (Kling/Fal)

## Configuration
The reel creation is highly configurable in `config.json`:

```json
{
  "reel": {
    "duration": 60,                    // target duration in seconds
    "platform": "tiktok",              // tiktok, instagram, youtube, twitter
    "music": {
      "provider": "elevenlabs",        // uses config.audio ( /audio key ) — not a separate hardcoded key
      "style": "upbeat",                // mood/style for generated music
      "beatSync": true,                 // sync cuts to music beat
      "fadeInOut": true                // add fade transitions
    },
    "captions": {
      "enabled": true,
      "provider": "auto",               // auto, elevenlabs, manual
      "style": "default"                // default, instagram, tiktok, youtube
    },
    "motionGraphics": {
      "enabled": true,
      "provider": "kling",              // uses config.image + `kling login` — not an inline API key
      "cardStyle": "default"            // default, dark-paper, glass-popout
    },
    "template": "default"               // template name from style-templates
  }
}
```

Platform presets adjust:
- Duration limits (TikTok: 15-60s, Instagram: 15-90s, YouTube: 1-5min)
- Aspect ratio (9:16 vertical, 1:1 square, 16:9 horizontal)
- Caption styling
- Motion graphics card selection

## Workflow
The skill follows this pipeline:

1. **Transcribe** - Auto-generate transcript from footage audio (Whisper/ElevenLabs Scribe)
2. **Analyze** - Detect silence, key talking points, emotion markers
3. **Cut** - Trim to target duration, removing dead air and mistakes
4. **Caption** - Generate and burn styled captions
5. **Motion Graphics** - Overlay relevant motion graphics cards at key points
6. **Music** - Add background music, beat-sync cuts if enabled
7. **Export** - Render final video optimized for target platform

## Usage
```javascript
// Create a full reel from raw footage
/video reel --path footage.mp4 --platform tiktok --duration 30

// Or with specific overrides
/video reel --path footage.mp4 --platform instagram --duration 45 --music.style "calm" --no-captions
```

## Output
Returns the path to the final rendered video file, optimized for the target platform with all requested enhancements applied.
