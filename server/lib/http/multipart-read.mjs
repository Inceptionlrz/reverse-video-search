// 入站 multipart/form-data 流式解析：文件部分直接落盘，字段部分留内存。
// 只依赖 Buffer.indexOf 做分帧，不假设 content-transfer-encoding。
// 用法：readMultipart(req, { boundary, limits, hooks }) → { fields, files:[{field,filename,contentType,path,bytes}] }
import fs from 'node:fs';
import path from 'node:path';
import { badRequest } from '../errors.mjs';

const DEFAULT_LIMITS = { maxFileBytes: 2 * 1024 * 1024 * 1024, maxFieldBytes: 1024 * 1024, maxFiles: 8 };

export function boundaryFromContentType(contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType || ''));
  const value = m ? (m[1] || m[2]) : null;
  if (!value) return null;
  return value.trim();
}

function headerLines(block) {
  const out = {};
  for (const line of String(block).split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return out;
}

function dispositionName(headers) {
  const disp = headers['content-disposition'] || '';
  const name = /\bname="([^"]*)"/i.exec(disp);
  const filename = /\bfilename="([^"]*)"/i.exec(disp);
  return { name: name ? name[1] : null, filename: filename ? filename[1] : null };
}

export async function readMultipart(req, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  const contentType = req.headers['content-type'] || '';
  const boundary = options.boundary || boundaryFromContentType(contentType);
  if (!boundary) throw badRequest('缺少 multipart boundary');

  const delimiter = Buffer.from(`--${boundary}`, 'utf8');
  const fields = {};
  const files = [];
  let fileCount = 0;

  let buf = Buffer.alloc(0);
  let state = 'preamble'; // preamble → headers → body → done
  let current = null; // { headers, chunks, bytes, stream, path }
  let tooLarge = false;

  const append = (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
  };

  const fail = (message) => {
    throw badRequest(message);
  };

  const startPart = (headerBlock) => {
    const headers = headerLines(headerBlock);
    const { name, filename } = dispositionName(headers);
    if (!name) fail('multipart 部分缺少 name');
    if (filename !== null) {
      fileCount += 1;
      if (fileCount > limits.maxFiles) fail(`文件数量超过上限（${limits.maxFiles}）`);
      const safeName = path.basename(filename).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_') || 'upload.bin';
      const dir = options.uploadDir || path.join(process.cwd(), 'data', 'uploads');
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `${Date.now()}_${safeName}`);
      current = {
        headers,
        name,
        filename: safeName,
        contentType: headers['content-type'] || 'application/octet-stream',
        chunks: [],
        bytes: 0,
        stream: fs.createWriteStream(filePath),
        path: filePath,
        isFile: true,
      };
    } else {
      current = {
        headers,
        name,
        chunks: [],
        bytes: 0,
        isFile: false,
      };
    }
  };

  const endPart = () => {
    if (!current) return;
    if (current.isFile) {
      current.stream.end();
      files.push({
        field: current.name,
        filename: current.filename,
        contentType: current.contentType,
        path: current.path,
        bytes: current.bytes,
      });
    } else {
      fields[current.name] = Buffer.concat(current.chunks).toString('utf8');
    }
    current = null;
  };

  const processBuffer = (final) => {
    for (;;) {
      if (state === 'preamble') {
        const idx = buf.indexOf(delimiter);
        if (idx < 0) {
          if (buf.length > delimiter.length) buf = buf.subarray(buf.length - delimiter.length);
          return;
        }
        buf = buf.subarray(idx + delimiter.length);
        state = 'part-head';
        continue;
      }
      if (state === 'part-head') {
        if (buf.length < 2) {
          if (!final) return;
          fail('multipart 数据不完整');
        }
        if (buf[0] === 0x2d && buf[1] === 0x2d) {
          state = 'done';
          return;
        }
        if (buf[0] !== 0x0d || buf[1] !== 0x0a) fail('multipart 分帧异常');
        const headEnd = buf.indexOf('\r\n\r\n');
        if (headEnd < 0) {
          if (buf.length > 64 * 1024) fail('multipart 头部过大');
          if (!final) return;
          fail('multipart 数据不完整');
        }
        const headerBlock = buf.subarray(4, headEnd).toString('utf8');
        buf = buf.subarray(headEnd + 4);
        startPart(headerBlock);
        state = 'body';
        continue;
      }
      if (state === 'body') {
        const searchFrom = Math.max(0, buf.length - delimiter.length - 4);
        const idx = buf.indexOf(delimiter, searchFrom);
        if (idx < 0) {
          const keep = delimiter.length + 4;
          const emitEnd = Math.max(0, buf.length - keep);
          if (emitEnd > 0) emitBody(buf.subarray(0, emitEnd));
          buf = buf.subarray(emitEnd);
          if (!final) return;
          fail('multipart 数据不完整（未找到结束边界）');
        }
        if (idx < 2) fail('multipart 分帧异常');
        const bodyEnd = idx - 2; // 去掉前导 \r\n
        if (bodyEnd > 0) emitBody(buf.subarray(0, bodyEnd));
        endPart();
        buf = buf.subarray(idx + delimiter.length);
        state = 'part-head';
        continue;
      }
      if (state === 'done') return;
    }
  };

  function emitBody(chunk) {
    if (!chunk.length || !current) return;
    current.bytes += chunk.length;
    if (current.isFile) {
      if (current.bytes > limits.maxFileBytes) {
        tooLarge = true;
        current.stream.destroy();
        return;
      }
      current.stream.write(chunk);
    } else {
      if (current.bytes > limits.maxFieldBytes) {
        current.chunks = [];
        return;
      }
      current.chunks.push(chunk);
    }
  }

  for await (const chunk of req) {
    if (state === 'done') break;
    append(chunk);
    processBuffer(false);
    if (tooLarge) {
      const e = badRequest('上传文件超过大小上限', { limit_bytes: limits.maxFileBytes });
      e.code = 'UPLOAD_REJECTED';
      throw e;
    }
  }
  processBuffer(true);
  if (state !== 'done') fail('multipart 数据不完整');
  return { fields, files };
}

export default readMultipart;
