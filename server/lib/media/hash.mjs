// dHash：ffmpeg 出 9x8 灰度（72 字节），Node 侧逐行比较相邻像素得 64 bit。
// 相似度口径：sim = (1 - 汉明距离 / 64) * 100（SPEC 第 9 节）。
import { spawnBinary } from './probe.mjs';

export const DHASH_BITS = 64;

export function computeDhash(grayBuffer) {
  const need = 9 * 8;
  if (!Buffer.isBuffer(grayBuffer) || grayBuffer.length < need) return null;
  const bits = [];
  for (let y = 0; y < 8; y += 1) {
    const row = y * 9;
    for (let x = 0; x < 8; x += 1) {
      bits.push(grayBuffer[row + x] > grayBuffer[row + x + 1] ? 1 : 0);
    }
  }
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    const nibble = (bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3];
    hex += nibble.toString(16);
  }
  return hex;
}

export async function dhashOfFile(cfg, filePath) {
  const args = ['-v', 'error', '-i', filePath, '-vf', 'scale=9:8,format=gray', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'];
  const res = await spawnBinary(cfg.ffmpeg, args, { timeoutMs: cfg.media.extractTimeoutMs });
  return computeDhash(res.stdout);
}

export function hammingDistance(hexA, hexB) {
  if (!hexA || !hexB || hexA.length !== hexB.length) return null;
  let bitsA = BigInt(`0x${hexA}`);
  let bitsB = BigInt(`0x${hexB}`);
  let distance = 0;
  let x = bitsA ^ bitsB;
  while (x > 0n) {
    distance += Number(x & 1n);
    x >>= 1n;
  }
  return distance;
}

export function similarityFromHamming(distance) {
  if (distance === null || distance === undefined) return null;
  return Math.round((1 - distance / DHASH_BITS) * 10000) / 100;
}

export function hashSimilarity(hexA, hexB) {
  return similarityFromHamming(hammingDistance(hexA, hexB));
}

// 帧内去重：相邻帧汉明距离 <= 阈值归入同一组，组内非首帧标记重复。
export function groupByHamming(frames, threshold = 6) {
  const groups = [];
  let current = null;
  for (const frame of frames) {
    if (!current) {
      current = { dup_group: groups.length + 1, members: [frame] };
      groups.push(current);
      continue;
    }
    const head = current.members[0];
    const distance = hammingDistance(head.dhash, frame.dhash);
    if (distance !== null && distance <= threshold) {
      current.members.push(frame);
    } else {
      current = { dup_group: groups.length + 1, members: [frame] };
      groups.push(current);
    }
  }
  const assignments = [];
  for (const group of groups) {
    group.members.forEach((frame, index) => {
      assignments.push({ id: frame.id, dup_group: group.dup_group, is_duplicate: index > 0 ? 1 : 0 });
    });
  }
  return assignments;
}
