// multipart/form-data 构造。只做二进制拼装，不做网络请求。
import crypto from 'node:crypto';

export function boundary() {
  return `----rvs${crypto.randomBytes(12).toString('hex')}`;
}

function partHeader(bound, name, filename, contentType, isBinary) {
  let disp = `Content-Disposition: form-data; name="${name}"`;
  if (filename) disp += `; filename="${filename}"`;
  const lines = [disp];
  lines.push(`Content-Type: ${isBinary ? contentType || 'application/octet-stream' : 'text/plain; charset=utf-8'}`);
  if (isBinary) lines.push('Content-Transfer-Encoding: binary');
  return Buffer.from(`--${bound}\r\n${lines.join('\r\n')}\r\n\r\n`, 'utf8');
}

export function buildMultipart({ fields = [], files = [], bound = boundary() } = {}) {
  const chunks = [];
  for (const field of fields) {
    chunks.push(partHeader(bound, field.name, null, null, false));
    chunks.push(Buffer.from(String(field.value ?? ''), 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  for (const file of files) {
    chunks.push(partHeader(bound, file.field, file.filename, file.contentType, true));
    chunks.push(Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content), 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${bound}--\r\n`, 'utf8'));
  const body = Buffer.concat(chunks);
  return { body, contentType: `multipart/form-data; boundary=${bound}`, byteLength: body.length };
}
