# Video Caption

Generate and burn captions/subtitles into video files for social media reels, YouTube Shorts, and TikTok.

## When to use
- User has a transcript and wants captions burned into video
- Need styled captions that match a brand aesthetic
- Want to optimize caption placement for different platforms (Instagram, TikTok, YouTube)
- Need forced subtitles for silent autoplay viewing

## Triggers
- "add captions to"
- "burn subtitles into"
- "generate captions for"
- "make video captions"
- "subtitle this video"

## Allowed Tools
- `bash` - for running ffmpeg commands with subtitle filters
- `read` - for reading transcript files
- `write` - for saving output video

## Configuration
Captions are configured per-platform in `config.json`:

```json
{
  "captions": {
    "font": "Arial-Bold",
    "fontSize": 36,
    "color": "#FFFFFF",
    "background": "#00000080",
    "position": "bottom",     // bottom, top, middle
    "marginBottom": 50,
    "opacity": 0.8,
    "maxCharsPerLine": 40,
    "align": "center"         // left, center, right
  }
}
```

Platform presets:
- `instagram`: optimized for square/vertical video, safe margin settings
- `tiktok`: vertical video caption positioning
- `youtube`: standard 16:9 caption positioning
- `generic`: custom settings from above

## Usage
```javascript
// Burn captions from a transcript file into a video
/video caption --video footage.mp4 --transcript transcript.json --platform tiktok

// Or with custom settings
/video caption --video footage.mp4 --transcript transcript.json --font "Roboto" --fontSize 32 --color "#FF0000"
```

## Output
Returns the path to the new video file with burned-in captions. The original video is not modified.
