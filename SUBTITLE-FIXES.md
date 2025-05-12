# Subtitle Rendering Fixes

This document describes the issues found with subtitle rendering in the video generation process and the fixes applied.

## Issues Identified

1. **Subtitle Z-Order Issue**: Subtitles were being rendered behind the waveform visualization
2. **Subtitle Positioning**: Subtitles were positioned too low on the screen
3. **Subtitle Visibility**: Subtitles were not clearly visible against the background
4. **Timestamp Calculation**: The handling of subtitle timing was inconsistent
5. **Subtitle Debugging**: Insufficient logging made it difficult to diagnose subtitle issues

## Fixes Applied

### 1. `VideoGenerator.js` Rendering Changes

- Modified the subtitle rendering order to ensure subtitles are drawn after (and therefore on top of) the waveform
- Improved the subtitle background opacity for better readability
- Adjusted the vertical position to place subtitles directly in front of the waveform
- Increased the font size and added stronger shadow effects for better visibility
- Added comprehensive debug logging for subtitle timing and activation

### 2. `ClipUtils.js` Subtitle Processing

- Added validation for subtitle objects to ensure they have the required properties
- Added time adjustment logic to align subtitle timestamps with clip start/end times
- Improved subtitle debugging to track them through the processing pipeline
- Increased the default frame rate for smoother subtitle rendering

### 3. Test Scripts

- Updated `test-subtitles.js` with more consistent timing for easier debugging
- Created `setup-subtitle-test.js` to help prepare the test environment
- Added NPM scripts to make testing easier

## How to Test

1. First, set up the test environment:
   ```
   npm run setup-subtitle-test
   ```
   This will create:
   - Test directories (assets, output)
   - A sample watermark
   - A sample profile image
   - A sample audio file (if ffmpeg is installed)

2. Run the subtitle test:
   ```
   npm run test-subtitles
   ```
   This will generate a video with sample subtitles. The output will be in `./output/test-subtitles.mp4`.

3. Check the console logs for debugging information:
   - `[DEBUG]` logs show information about subtitle rendering
   - Look for any `[WARN]` or `[ERROR]` logs that might indicate issues

## What to Look For

In the generated video, you should see:

1. The waveform visualization at the bottom half of the video
2. Subtitles appearing in a semi-transparent black box ON TOP OF the waveform
3. Each word should appear for 0.5 seconds according to the test timing
4. The subtitle text should be clearly readable with a white font and black background

## Production Considerations

The changes made include extensive debugging logs that may impact performance. Once you've confirmed the subtitles are working correctly, you may want to reduce the logging by:

1. Removing or commenting out debug logs in `getActiveSubtitles` method
2. Keeping only essential validation in the `generateShareableVideo` method

## Next Steps

If subtitles are still not appearing correctly:

1. Check that the audio file duration and the subtitles duration match
2. Verify that the `exactDuration` property is being set correctly in `generateFrames`
3. Use the additional debug logs to identify where subtitles might be dropped in the pipeline 