# Motion Graphics Cards

Select and apply motion graphics cards to video reels. The kit includes 406 draft motion-graphics cards across two styles with CSS tokens, editable slots, and scene templates.

## When to use
- User wants to add animated elements to their video reel
- Need titles, lower thirds, transitions, or decorative elements
- Want to match a specific visual style (dark graph paper, left glass popout)
- Need reusable asset cards that can be customized with own text

## Triggers
- "add motion graphics"
- "apply card to"
- "insert title"
- "add lower third"
- "use card from library"
- "browse motion graphics"

## Allowed Tools
- `read` - for reading card manifests and registry
- `write` - for saving customized card configurations
- `bash` - for running any rendering commands

## Configuration
Card library is configured in `config.json` with paths to the style library:

```json
{
  "motionGraphics": {
    "libraryPath": "style-library",
    "registryFile": "registry.json",
    "templateGuide": "style-templates/GUIDE.md",
    "defaultStyle": "dark-graph-paper",     // or "left-glass-popout"
    "cardLimit": 10,                       // max cards per reel
    "autoApply": false                     // whether to auto-select cards or manual
  }
}
```

## Card Styles
Two primary styles are included:

### Dark Graph Paper
- Grid-based layout with technical feel
- Suitable for engineering, tech, data-focused content
- CSS tokens for colors, fonts, spacing

### Left Glass Popout
- Modern glassmorphism style
- Title pops out to the left with subtle animation
- Suitable for personal branding, creator content

## Registry
Searchable card metadata in `registry.json` allows searching by:
- Keyword (title, lower-third, transition, etc.)
- Style category
- CSS token availability
- Animation type

## Usage
```javascript
// List available cards
/video cards --style dark-graph-paper --keyword "title"

// Apply a card to video at a specific time
/video apply-card --video reel.mp4 --card "title-intro-01" --at 00:00 --text "My Reel"

// Search and filter
/video cards --search "lower third" --style "left-glass-popout"
```

## Output
Returns card metadata including:
- Card name and ID
- CSS tokens and classes
- Animation parameters
- Recommended text bounds and safe areas
