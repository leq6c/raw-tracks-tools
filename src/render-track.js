import * as Path from 'node:path';
import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';

import { runFfmpegCommandAsync } from './ffexec.js';

const g_tempFilePrefix = 'rawtracks_';
let g_audioEncoderArgs;

function getAudioEncoderArgs() {
  if (g_audioEncoderArgs) return g_audioEncoderArgs;

  let hasLibfdk = false;
  try {
    const probe = childProcess.spawnSync(
      'ffmpeg',
      ['-hide_banner', '-encoders'],
      { encoding: 'utf-8' }
    );
    if (probe.status === 0 && probe.stdout.includes('libfdk_aac')) {
      hasLibfdk = true;
    }
  } catch (err) {
    console.warn('Unable to query ffmpeg encoders: %s', err?.message || err);
  }

  if (hasLibfdk) {
    g_audioEncoderArgs = [
      '-c:a',
      'libfdk_aac',
      '-b:a',
      '256k',
      '-profile:a',
      'aac_low',
      '-vbr',
      '0',
      '-ar',
      '48000',
    ];
  } else {
    console.warn(
      'libfdk_aac not available in ffmpeg build; falling back to builtin aac encoder.'
    );
    g_audioEncoderArgs = ['-c:a', 'aac', '-b:a', '256k', '-ar', '48000'];
  }

  return g_audioEncoderArgs;
}

export async function normalizeAudioTrack(
  ctxName,
  analysis,
  inputPath,
  outputPath,
  codec = 'aac'
) {
  if (analysis?.isVideo)
    throw new Error('normalizeAudioTrack expects audio input');

  if (analysis.startTime == null)
    throw new Error('normalizeAudioTrack expects startTime key');

  if (codec === 'wav') {
    await normalizeAudioTrackToWav(ctxName, analysis, inputPath, outputPath);
    return;
  }

  if (codec !== 'aac') {
    throw new Error(`Unsupported audio codec "${codec}"`);
  }

  await normalizeAudioTrackToAAC(ctxName, analysis, inputPath, outputPath);
}

async function normalizeAudioTrackToAAC(
  ctxName,
  analysis,
  inputPath,
  outputPath
) {
  // the audio version of this operation just pads the start with silence.
  // we don't need to do gap rendering like with video.

  const args = [
    '-i',
    inputPath,
    '-af',
    // ffmpeg quirk: aresample needs to come before adelay in the filter chain
    `aresample=async=1,adelay=${Math.floor(
      analysis.startTime * 1000
    )}:all=true`,
    ...getAudioEncoderArgs(),
    outputPath,
  ];
  await runFfmpegCommandAsync(`audio_${ctxName}`, args);
}

async function normalizeAudioTrackToWav(
  ctxName,
  analysis,
  inputPath,
  outputPath
) {
  const args = [
    '-i',
    inputPath,
    '-af',
    `aresample=async=1,adelay=${Math.floor(
      analysis.startTime * 1000
    )}:all=true`,
    '-ar',
    '48000',
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    outputPath,
  ];
  await runFfmpegCommandAsync(`audio_${ctxName}_wav`, args);
}

async function renderBlackGapSegment(
  ctxName,
  gapIdx,
  videoSize,
  duration,
  baseArgs,
  dst
) {
  const args = [
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=${videoSize.w}x${videoSize.h},format=yuv420p,scale=out_color_matrix=bt709:out_range=tv`,
    '-t',
    duration,
    ...baseArgs,
    dst,
  ];
  await runFfmpegCommandAsync(`rendergap_${gapIdx}_${ctxName}`, args);
}

async function renderHoldGapSegment(
  ctxName,
  gapIdx,
  gap,
  duration,
  tmpSource,
  sourceOffset,
  frameRate,
  baseArgs,
  dst,
  tmpDir,
  tmpFiles
) {
  const holdFrameOffset = gap.start - sourceOffset;
  if (holdFrameOffset <= 0) {
    return false;
  }

  const frameStep = 1 / Math.max(frameRate, 1);
  const frameSeekTime = Math.max(holdFrameOffset - frameStep, 0);
  const holdFramePath = Path.resolve(
    tmpDir,
    `${g_tempFilePrefix}${ctxName}_hold${gapIdx}.png`
  );
  tmpFiles.push(holdFramePath);

  let args = [
    '-ss',
    frameSeekTime,
    '-i',
    tmpSource,
    '-frames:v',
    '1',
    holdFramePath,
  ];
  await runFfmpegCommandAsync(`extracthold_${gapIdx}_${ctxName}`, args);

  args = [
    '-loop',
    '1',
    '-framerate',
    frameRate,
    '-i',
    holdFramePath,
    '-vf',
    'format=yuv420p,scale=out_color_matrix=bt709:out_range=tv',
    '-t',
    duration,
    ...baseArgs,
    dst,
  ];
  await runFfmpegCommandAsync(`renderhold_${gapIdx}_${ctxName}`, args);
  return true;
}

export async function normalizeVideoTrackToM4V(
  ctxName,
  analysis,
  inputPath,
  outputPath,
  opts = {}
) {
  if (!analysis?.isVideo)
    throw new Error('normalizeVideoTrack expects video input');

  if (!analysis.endTime || analysis.startTime == null)
    throw new Error(
      'normalizeVideoTrack expects non-zero endTime and startTime key'
    );

  if (!Array.isArray(analysis.gaps)) {
    throw new Error('normalizeVideoTrack expects analysis.gaps to be set');
  }
  if (!analysis.videoSize.w || !analysis.videoSize.h)
    throw new Error('normalizeVideoTrack expects analysis.videoSize to be set');

  const { videoSize, frameRate = 30, endTime, gaps } = analysis;
  const gapFill = opts.gapFill || 'black';
  if (!['black', 'hold'].includes(gapFill)) {
    throw new Error(`Unsupported gap fill mode "${gapFill}"`);
  }
  const sourceFilter = `scale=${videoSize.w}x${videoSize.h}:out_color_matrix=bt709:out_range=tv,format=yuv420p`;
  const segmentFilter = 'setpts=PTS-STARTPTS,format=yuv420p';

  const segments = [];
  let t = 0;
  for (const gap of gaps) {
    if (gap.start > t) {
      segments.push({ start: t, end: gap.start, type: 'src' });
    }

    segments.push({ ...gap, type: 'gap' });

    t = gap.end;
  }
  if (t < endTime) {
    segments.push({ start: t, end: endTime, type: 'src' });
  }

  console.log('video segments to be written: ', segments);

  if (segments.length > 3) {
    throw new Error('Too many segments to render');
  }

  // TODO: allow caller to set this
  const bitRate = '5000k';

  const baseArgs = ['-r', frameRate, '-b:v', bitRate, '-c:v', 'libx264', '-preset', 'ultrafast'];
  let args;

  const tmpDir = '/tmp';
  const tmpFiles = [];

  // first convert the entire input.
  // ffmpeg can't seek reliably within the original,
  // so we need this intermediate to be able to extract segments.
  const tmpSource = Path.resolve(
    tmpDir,
    `${g_tempFilePrefix}${ctxName}_full.m4v`
  );
  tmpFiles.push(tmpSource);

  // the file rendered in tmpSource will start at the first sample's time in the raw-tracks file,
  // so we must apply this offset to when extracting segments from it.
  const sourceOffset = analysis.startTime;

  args = [
    '-i',
    inputPath,
    '-vf',
    sourceFilter,
    ...baseArgs,
    tmpSource,
  ];
  await runFfmpegCommandAsync(`convert_${ctxName}`, args);

  let ffmpegConcatFile = '';

  for (let i = 0; i < segments.length; i++) {
    const { start, end, type } = segments[i];

    const duration = Math.max(end - start, 0);

    const tmpFileName = `${g_tempFilePrefix}${ctxName}_seg${i}.m4v`;
    ffmpegConcatFile += `file '${tmpFileName}'\n`;

    const dst = Path.resolve(tmpDir, tmpFileName);
    tmpFiles.push(dst);

    if (type === 'gap') {
      let didRenderHold = false;
      if (gapFill === 'hold') {
        didRenderHold = await renderHoldGapSegment(
          ctxName,
          i,
          segments[i],
          duration,
          tmpSource,
          sourceOffset,
          frameRate,
          baseArgs,
          dst,
          tmpDir,
          tmpFiles
        );
      }
      if (!didRenderHold) {
        await renderBlackGapSegment(
          ctxName,
          i,
          videoSize,
          duration,
          baseArgs,
          dst
        );
      }
    } else {
      const args = [
        '-ss',
        start - sourceOffset,
        '-t',
        duration,
        '-i',
        tmpSource,
        '-vf',
        segmentFilter,
        ...baseArgs,
        dst,
      ];
      await runFfmpegCommandAsync(`extractseg_${i}_${ctxName}`, args);
    }
  }

  const concatTempPath = Path.resolve(
    tmpDir,
    `${g_tempFilePrefix}${ctxName}_concat.txt`
  );
  fs.writeFileSync(concatTempPath, ffmpegConcatFile, { encoding: 'utf-8' });

  tmpFiles.push(concatTempPath);

  //console.log('concat:\n', ffmpegConcatFile);

  args = ['-f', 'concat', '-i', concatTempPath, '-c', 'copy', outputPath];
  await runFfmpegCommandAsync(`concat_${ctxName}`, args);

  for (const path of tmpFiles) {
    fs.rmSync(path);
  }
}
