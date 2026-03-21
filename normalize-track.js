import * as Path from 'node:path';
import { parseArgs } from 'node:util';
import * as fs from 'node:fs';

import { analyzeTrack } from './src/analyze-track.js';
import {
  normalizeAudioTrack,
  normalizeVideoTrackToM4V,
} from './src/render-track.js';
import { runFfmpegCommandAsync } from './src/ffexec.js';

function formatTimecode(totalSeconds) {
  const totalMs = Math.max(0, Math.round(totalSeconds * 1000));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const milliseconds = totalMs % 1000;

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(
    2,
    '0'
  )}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(
    3,
    '0'
  )}`;
}

function writeGapsSidecar(outputPath, videoAnalysis, audioAnalysis) {
  const sidecarPath = Path.resolve(
    Path.dirname(outputPath),
    `${Path.basename(outputPath, Path.extname(outputPath))}.gaps.json`
  );
  const gaps = (videoAnalysis.gaps || []).map((gap, index) => {
    const duration = gap.end - gap.start;
    return {
      index,
      start: gap.start,
      end: gap.end,
      duration,
      startMs: Math.round(gap.start * 1000),
      endMs: Math.round(gap.end * 1000),
      durationMs: Math.round(duration * 1000),
      startTimecode: formatTimecode(gap.start),
      endTimecode: formatTimecode(gap.end),
      durationTimecode: formatTimecode(duration),
    };
  });

  const payload = {
    version: 1,
    timeline: 'normalized-output',
    outputFile: outputPath,
    gapCount: gaps.length,
    videoStartTime: videoAnalysis.startTime,
    audioStartTime: audioAnalysis?.startTime ?? null,
    gaps,
  };

  fs.writeFileSync(sidecarPath, JSON.stringify(payload, null, 2) + '\n', {
    encoding: 'utf-8',
  });
  console.log('gap sidecar written to: %s', sidecarPath);
}

const args = parseArgs({
  options: {
    input: {
      type: 'string',
      short: 'i',
      multiple: true,
    },
    output_dir: {
      type: 'string',
      short: 'o',
    },
    'audio-codec': {
      type: 'string',
    },
  },
});

if (args.values.input.length < 1) {
  console.error(
    'input is required using -i (can provide multiple files in order to combine audio and video)'
  );
  process.exit(1);
}

const outputDir = args.values.output_dir || Path.dirname(args.values.input[0]);
if (args.values.output_dir) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const audioCodec = (args.values['audio-codec'] || 'aac').toLowerCase();
if (!['aac', 'wav'].includes(audioCodec)) {
  console.error('audio-codec must be either "aac" or "wav"');
  process.exit(1);
}

let videoPath;
let audioPath;
let combinedOutputPath;
let videoAnalysis;
let audioAnalysis;
let gapsOutputTargetPath;

for (const inputPath of args.values.input) {
  if (!fs.existsSync(inputPath)) {
    console.error("input path doesn't exist: ", inputPath);
    process.exit(1);
  }
  const basename = Path.basename(inputPath, Path.extname(inputPath));

  const analysis = await analyzeTrack(`analyze_${basename}`, inputPath);

  if (analysis.isVideo) {
    videoAnalysis = analysis;
    const videoOutputPath = Path.resolve(
      outputDir,
      basename + '_normalized.m4v'
    );

    await normalizeVideoTrackToM4V(
      basename,
      analysis,
      inputPath,
      videoOutputPath
    );
    videoPath = videoOutputPath;
    combinedOutputPath = Path.resolve(outputDir, basename + '_combined.mp4');
  } else {
    const audioExt = audioCodec === 'wav' ? '.wav' : '.aac';
    const audioOutputPath = Path.resolve(
      outputDir,
      basename + '_normalized' + audioExt
    );

    audioAnalysis = analysis;
    await normalizeAudioTrack(
      basename,
      analysis,
      inputPath,
      audioOutputPath,
      audioCodec
    );
    if (audioCodec === 'aac') {
      audioPath = audioOutputPath;
    }
  }
}

if (audioCodec === 'aac' && videoPath && audioPath && combinedOutputPath) {
  const basename = Path.basename(
    combinedOutputPath,
    Path.extname(combinedOutputPath)
  );

  const args = [
    '-i',
    videoPath,
    '-i',
    audioPath,
    '-c',
    'copy',
    '-map',
    '0:0',
    '-map',
    '1:0',
    combinedOutputPath,
  ];
  await runFfmpegCommandAsync(`combine_${basename}`, args);
  gapsOutputTargetPath = combinedOutputPath;

  fs.rmSync(videoPath);
  fs.rmSync(audioPath);

  console.log('combined video and audio written to: %s', combinedOutputPath);
}

if (!gapsOutputTargetPath && videoPath) {
  gapsOutputTargetPath = videoPath;
}

if (videoAnalysis && gapsOutputTargetPath) {
  writeGapsSidecar(gapsOutputTargetPath, videoAnalysis, audioAnalysis);
}
