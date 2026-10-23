// 统一缩放转码：抽帧产出与图床上传前的降质处理（长边 <= 640，JPEG q=3）。
import { spawnBinary } from './probe.mjs';

export async function transcode(cfg, { input, output, maxEdge = 320, quality = 3 }) {
  const args = [
    '-v', 'error',
    '-i', input,
    '-vf', `scale=${maxEdge}:-2`,
    '-q:v', String(quality),
    output,
    '-y',
  ];
  const res = await spawnBinary(cfg.ffmpeg, args, { timeoutMs: cfg.media.extractTimeoutMs });
  void res;
  return output;
}

// 图床上传前的降质：长边 <= 640 并重编码为 JPEG，降低可辨识度与体积（ARCHITECTURE 4.4）。
export async function prepareForUpload(cfg, { input, output, maxEdge, quality }) {
  return transcode(cfg, {
    input,
    output,
    maxEdge: maxEdge ?? cfg.bridge.maxEdge,
    quality: quality ?? cfg.bridge.jpegQuality,
  });
}
