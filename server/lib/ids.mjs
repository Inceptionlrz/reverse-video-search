// ULID 风格短 ID：时间前缀（Crockford base32）+ 随机后缀，保证同毫秒内字典序递增。
import crypto from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RAND_LEN = 16;

function encodeTime(ms) {
  let out = '';
  let n = ms;
  for (let i = TIME_LEN - 1; i >= 0; i -= 1) {
    out = ALPHABET[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

function encodeRandom() {
  const bytes = crypto.randomBytes(RAND_LEN);
  let out = '';
  for (let i = 0; i < RAND_LEN; i += 1) out += ALPHABET[bytes[i] % 32];
  return out;
}

export function ulid(now = Date.now()) {
  return encodeTime(now) + encodeRandom();
}

export const newTaskId = () => `rvs_t_${ulid()}`;
export const newFrameId = () => `rvs_f_${ulid()}`;
export const newAnalysisId = () => `rvs_a_${ulid()}`;
export const newResultId = () => `rvs_r_${ulid()}`;
export const newHitId = () => `rvs_rh_${ulid()}`;
export const newRequestId = () => `rvs_req_${ulid()}`;
