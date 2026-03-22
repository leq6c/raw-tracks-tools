import { runFfprobeCommandAsync } from './ffprobe.js';

const MAX_REASONABLE_FRAME_RATE = 120;
const COMMON_FRAME_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

export async function analyzeTrack(ctxName, inputPath, opts = {}) {
  const { frames, streams } = await runFfprobeCommandAsync(ctxName, [
    '-show_frames',
    '-show_streams',
    inputPath,
  ]);

  if (streams?.length !== 1) {
    console.error('Expected one stream in file, got: %d', streams?.length);
    throw new Error('Invalid input file');
  }
  const isVideo = streams[0]?.codec_type === 'video';

  if (!frames || frames.length < 1) {
    console.error('No frames found in file.');
    throw new Error('Invalid input file');
  }

  const firstFrame = frames[0];
  if (
    !firstFrame.media_type ||
    firstFrame.media_type !== streams[0].codec_type
  ) {
    console.error('No media_type found in frame.');
    throw new Error('Invalid input file');
  }

  const lastFrame = frames[frames.length - 1];

  const ret = {
    streamMetadata: streams[0],
    isVideo,
    mediaType: streams[0].codec_type,
    numberOfFrames: frames.length,
    startTime: streams[0].start_time,
    endTime: lastFrame.pts_time + (lastFrame.duration_time || 0),
  };

  if (isVideo) {
    let w = firstFrame.width;
    let h = firstFrame.height;
    for (let i = 1; i < frames.length; i++) {
      w = Math.max(w, frames[i].width);
      h = Math.max(h, frames[i].height);
    }
    ret.videoSize = {
      w,
      h,
    };

    ret.frameRate = estimateFrameRate(frames, ret.streamMetadata);
  }

  ret.gaps = findGaps(frames, opts.minGapDurationInSecs);

  return ret;
}

// --- utility functions ---

function findGaps(frames, gapMinDuration = 0.5) {
  const arr = [];
  const n = frames.length;

  for (let i = 0; i < n; i++) {
    const frame = frames[i];
    const prevFrame = i > 0 ? frames[i - 1] : null;
    const prevFrameTime = prevFrame ? prevFrame.pts_time : 0;
    const intv = frame.pts_time - prevFrameTime;
    if (intv >= gapMinDuration) {
      const prevFrameEnd = prevFrameTime + (prevFrame?.duration_time || 0);
      arr.push({
        start: prevFrameEnd,
        end: frame.pts_time,
      });
    }
  }

  return arr;
}

function estimateFrameRate(frames, streamMetadata) {
  const candidates = [
    parseFrameRate(streamMetadata?.avg_frame_rate),
    estimateFrameRateFromFrames(frames),
    parseFrameRate(streamMetadata?.r_frame_rate),
  ];

  for (const fps of candidates) {
    if (isFinite(fps) && fps > 0 && fps <= MAX_REASONABLE_FRAME_RATE) {
      return snapFrameRate(fps);
    }
  }

  return 30;
}

function parseFrameRate(fpsStr) {
  if (!fpsStr || fpsStr === '0/0') return null;

  const idx = fpsStr.indexOf('/');
  if (idx > 0) {
    const nom = parseFloat(fpsStr.substring(0, idx));
    const den = parseFloat(fpsStr.substring(idx + 1));
    if (isFinite(nom) && isFinite(den) && den > 0) {
      return nom / den;
    }
  }

  const value = parseFloat(fpsStr);
  return isFinite(value) ? value : null;
}

function estimateFrameRateFromFrames(frames) {
  const intervals = [];

  for (let i = 1; i < frames.length; i++) {
    const delta = frames[i].pts_time - frames[i - 1].pts_time;
    if (delta > 0 && delta < 0.2) {
      intervals.push(delta);
    }
  }

  if (intervals.length < 10) return null;

  intervals.sort((a, b) => a - b);
  const trim = Math.floor(intervals.length * 0.1);
  const trimmed =
    trim > 0 ? intervals.slice(trim, intervals.length - trim) : intervals;

  if (trimmed.length < 1) return null;

  const avgInterval =
    trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length;
  if (!isFinite(avgInterval) || avgInterval <= 0) return null;

  return 1 / avgInterval;
}

function snapFrameRate(fps) {
  for (const candidate of COMMON_FRAME_RATES) {
    if (Math.abs(fps - candidate) / candidate <= 0.03) {
      return candidate;
    }
  }

  return Math.round(fps * 1000) / 1000;
}
