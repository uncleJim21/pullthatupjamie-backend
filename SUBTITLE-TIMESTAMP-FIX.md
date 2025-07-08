# Subtitle Timestamp Fix Documentation

## The Problem

We identified a critical issue with subtitle rendering in the video generation process: **timestamps were not being properly adjusted**.

When you generate a clip from a longer audio file, the subtitles need to have timestamps that are **relative to the clip start time**, not the original audio file. For example:

- Original audio file duration: 1 hour
- Clip extracted: from 30:00 to 30:30 (30 seconds clip)
- Subtitle at 30:05 in original audio should become 0:05 in the clip

The issue was that subtitles were being passed with their original absolute timestamps (e.g., 1684.02 seconds into the original audio), but when rendering the video, the timestamps were being interpreted as relative to 0 (the start of the clip). This resulted in no subtitles being displayed because they were out of range.

## The Fix

We made three key changes to fix this issue:

### 1. ClipUtils.js - generateShareableVideo Method

Added a timestamp adjustment step in the `generateShareableVideo` method to ensure subtitles are always relative to clip start:

```javascript
// Get clip start time
const clipStartTime = clipData.timeContext?.start_time ?? 0;

if (subtitles[0].start > 10) { // This indicates absolute timestamps (not 0-based)
    console.log(`[INFO] Adjusting subtitle timestamps from absolute to relative`);
    
    // Adjust all timestamps to be relative to clip start
    subtitles = subtitles.map(subtitle => ({
        ...subtitle,
        start: Math.max(0, subtitle.start - clipStartTime),
        end: Math.max(0, subtitle.end - clipStartTime)
    }));
}
```

### 2. ClipUtils.js - _backgroundProcessClip Method

Modified the `_backgroundProcessClip` method to **always** adjust subtitle timestamps for consistency:

```javascript
if (subtitles && subtitles.length > 0) {
    console.log(`[INFO] Adjusting all subtitle timestamps to be relative to clip start time`);
    
    // Adjust all subtitle timestamps relative to clip start time
    subtitles = subtitles.map(subtitle => ({
        ...subtitle,
        start: Math.max(0, subtitle.start - clipStartTime),
        end: Math.min(clipDuration, subtitle.end - clipStartTime)
    }))
    // Filter out subtitles outside the clip duration
    .filter(subtitle => subtitle.start < clipDuration && subtitle.end > 0);
    
    console.log(`[DEBUG] After adjustment: ${subtitles.length} subtitles remain in clip timeframe`);
}
```

### 3. VideoGenerator.js - getActiveSubtitles Method

Enhanced the `getActiveSubtitles` method with better debugging for timestamp mismatches:

```javascript
if (timestamp < 0.1) {  // Check in the first frame
    const timeInRange = this.subtitles.some(s => 
        timestamp >= s.start - 0.1 && timestamp <= s.end + 0.1
    );
    
    if (!timeInRange) {
        console.log(`[WARN] No subtitles match timestamp ${timestamp}. This likely means there's a timestamp mismatch.`);
        console.log(`[WARN] If subtitles use absolute timestamps (from original audio), they need to be adjusted to be relative to the clip.`);
    }
}
```

## How to Verify the Fix

After implementing these changes, you should see these log messages when generating videos with subtitles:

1. `[INFO] Adjusting all subtitle timestamps to be relative to clip start time`
2. Logs showing the subtitles before and after adjustment
3. `[DEBUG] Active subtitle at X.XX seconds: "Text"`

If subtitles are still not appearing:

1. Check the logs for any warning messages about timestamp mismatches
2. Verify that the subtitle timestamps after adjustment are between 0 and the clip duration
3. Make sure the `subtitles` array is being properly passed to `VideoGenerator`

## Workflow

The correct workflow for handling subtitles is now:

1. Generate subtitles with timestamps relative to the original audio
2. Pass them to `processClip` or `_backgroundProcessClip`
3. The timestamps will be automatically adjusted to be relative to the clip start time
4. `VideoGenerator` will now display the subtitles correctly on the video

This approach allows the subtitles to maintain their original timestamps for reuse with other clips, while ensuring they display correctly in any generated video clip. 