// ffprobe / ffmpeg 进程调用的唯一封装：一律 spawn + 参数数组（不经过 shell），禁止拼接 shell 字符串。
// 同层其他模块（extract / hash / encode）复用此处的 spawnBinary，避免重复实现子进程管理。
import { spawn } from 'node:child_process';

export class MediaProcessError extends Error {
  constructor(message, { code, stderr, bin, args }) {
    super(message);
    this.name = 'MediaProcessError';
    this.code = code;
    this.stderr = stderr;
    this.bin = bin;
    this.args = args;
  }
}

export function spawnBinary(bin, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120000;
  const maxBuffer = options.maxBuffer ?? 8 * 1024 * 1024;
  const cancelToken = options.cancelToken || null;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new MediaProcessError(`无法启动 ${bin}: ${err.message}`, { code: null, stderr: '', bin, args }));
      return;
    }

    const outChunks = [];
    let errBytes = 0;
    const errChunks = [];
    let truncated = false;
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      reject(new MediaProcessError(`${bin} 执行超时（${timeoutMs}ms）`, { code: null, stderr: '', bin, args }));
    }, timeoutMs);

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cancelToken) cancelToken.offAbort(onAbort);
      fn(value);
    };

    function onAbort() {
      child.kill();
      finish(reject, new MediaProcessError('任务已取消，进程被终止', { code: null, stderr: '', bin, args }));
    }
    if (cancelToken) cancelToken.onAbort(onAbort);

    child.stdout.on('data', (chunk) => outChunks.push(chunk));
    child.stderr.on('data', (chunk) => {
      errBytes += chunk.length;
      if (errBytes <= maxBuffer) errChunks.push(chunk);
      else truncated = true;
    });
    child.on('error', (err) => {
      finish(reject, new MediaProcessError(`${bin} 启动失败: ${err.message}`, { code: null, stderr: '', bin, args }));
    });
    child.on('close', (code) => {
      const stderr = Buffer.concat(errChunks).toString('utf8');
      if (code === 0) {
        finish(resolve, { code, stdout: Buffer.concat(outChunks), stderr, truncated });
      } else {
        finish(reject, new MediaProcessError(`${bin} 以非零状态退出 (${code})`, { code, stderr, bin, args }));
      }
    });
  });
}

export function tailLines(text, n = 20) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(-n).join('\n');
}

export async function probeMedia(cfg, filePath) {
  const args = [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=width,height,r_frame_rate,codec_name',
    '-of', 'default=nw=1',
    filePath,
  ];
  let res;
  try {
    res = await spawnBinary(cfg.ffprobe, args, { timeoutMs: cfg.media.probeTimeoutMs });
  } catch (err) {
    if (err instanceof MediaProcessError) {
      err.diagnosis = err.code === null ? 'ffprobe 不可用或文件不可读' : '文件无法解析（可能不是视频或已损坏）';
    }
    throw err;
  }
  const meta = { duration_ms: null, width: null, height: null, r_frame_rate: null, codec: null };
  // ffprobe 的 -show_entries 输出走 stdout（stderr 只放告警），此处解析 stdout。
  for (const line of res.stdout.toString('utf8').split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key === 'duration') meta.duration_ms = Math.round(Number.parseFloat(value) * 1000) || null;
    else if (key === 'width' && meta.width === null) meta.width = Number.parseInt(value, 10) || null;
    else if (key === 'height' && meta.height === null) meta.height = Number.parseInt(value, 10) || null;
    else if (key === 'r_frame_rate' && meta.r_frame_rate === null) meta.r_frame_rate = value || null;
    else if (key === 'codec_name' && meta.codec === null) meta.codec = value || null;
  }
  return meta;
}
