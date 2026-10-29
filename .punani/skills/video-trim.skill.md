# Video Trim

Clip and trim video footage to create social media-ready reels, removing dead air, mistakes, and unwanted sections.

## When to use
- User has raw footage and needs a concise reel
- Want to remove pauses, errors, and filler content
- Need to hit specific duration targets (15s, 30s, 60s for different platforms)
- Clip highlight reels from longer source material

## Triggers
- "trim this video"
- "clip to"
- "make a reel from"
- "cut out the"
- "remove the middle section"
- "create a highlight reel"

## Allowed Tools
- `bash` - for running ffmpeg/avconv cut commands
- `read` - for reading timecode/transcript files
- `write` - for saving trimmed output

## Configuration
Trim rules are configured in `config.json`:

```json
{
  "trimming": {
    "defaultDuration": 60,         // target reel duration in seconds
    "silenceThreshold": 0.5,       // seconds of silence to detect as "dead air"
    "minSegmentLength": 2,         // minimum clip segment length
    "maxGapBetweenSegments": 3,    // max gap to keep when cutting
    "platformPresets": {
      "instagram": 60,
      "tiktok": 15,
      "youtube": 120,
      "twitter": 30
    }
  }
}
```

## Usage
```javascript
// Trim a video to create a reel
/video trim --path footage.mp4 --targetDuration 60 --platform instagram

// Or with specific segments from a transcript
/video trim --path footage.mp4 --transcript video-transcribe.json --minSegmentLength 3
```

## Output
Returns the path to the trimmed video file. The tool creates a new file with only the selected segments, preserving the original aspect ratio and quality settings.
