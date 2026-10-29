# Video Transcribe

Transcribe video or audio files using Whisper or ElevenLabs Scribe to produce word-level transcripts with timestamps.

## When to use
- User has raw video footage and needs a transcript
- Need word-level timing for caption generation
- Want to extract dialogue and speaker changes from footage
- Preparing content for captioned social media reels

## Triggers
- "transcribe this video"
- "get transcript of"
- "convert video to text"
- "add captions to"
- "extract dialogue from"

## Allowed Tools
- `bash` - for running ffmpeg/whisper commands
- `read` - for reading transcript files
- `write` - for writing transcript output

## Configuration
This skill uses the `whisper` command-line tool or ElevenLabs Scribe API. Configure in `config.json`:

```json
{
  "transcribe": {
    "provider": "whisper",        // or "elevenlabs-scribe"
    "model": "base",              // whisper model: tiny, base, small, medium, large
    "elevenlabsKey": "your-key"  // if using ElevenLabs Scribe
  }
}
```

## Usage
```javascript
// Transcribe a video file
/video transcribe --path footage.mp4 --model base

// Or use ElevenLabs Scribe
/video transcribe --path footage.mp4 --provider elevenlabs-scribe
```

## Output
Returns a JSON transcript with segments containing:
- `text`: the spoken text
- `start`: start time in seconds
- `end`: end time in seconds
- `speaker`: optional speaker label (if detected)
