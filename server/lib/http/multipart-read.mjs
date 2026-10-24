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
  const pending = []; // 待落盘完成的 promise，返回前必须全部 await

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
      // 落盘是异步的：createWriteStream 的 fd 是异步打开、write 是排队写入的，
      // 只调 end() 就返回会让调用方（建任务 → ffprobe）读到尚未落盘/未关闭的
      // 文件——ENOENT 或半截文件，属间歇性上传失败的竞态。必须等句柄 close。
      pending.push(
        new Promise((resolve) => {
          current.stream.once('close', resolve);
          try {
            current.stream.end();
          } catch {
            // 已销毁（如超限被 destroy）时 end() 可能抛错，close 仍会到达
            resolve();
          }
        }),
      );
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
        // 第 129 行已强制 buf[0..1] 为 \r\n（boundary 与分帧头之间的前导 CRLF），
        // 故头部文本从字节 2 开始。此前误从 4 起切，首行头部被削掉前 2 字节
        // （Content-Disposition → ntent-Disposition），name/filename 正则失配，
        // 整个 multipart 上传报 400（P0：浏览器 FormData 是唯一上传路径）。
        const headerBlock = buf.subarray(2, headEnd).toString('utf8');
        buf = buf.subarray(headEnd + 4);
        startPart(headerBlock);
        state = 'body';
        continue;
      }
      if (state === 'body') {
        // 必须从头搜索：此前的 searchFrom = buf.length - D - 4 尾部优化隐含假设
        // 「delimiter 若在 buf 中必始于末尾 D+4 字节内」——但只要同一 chunk 里
        // delimiter 后还跟着后续 part（>4 字节，浏览器 FormData 的常态），真正的
        // 边界即被跳过、改配更后面的 delimiter，中间 part 的头与值全被吞进
        // 当前 part 本体（字段丢失 + 文件被污染）。buf 经下面 keep-back 后始终
        // 只有 D+4 字节存量，从头 indexOf 的代价可忽略。
        const idx = buf.indexOf(delimiter);
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
  await Promise.all(pending);
  return { fields, files };
}

export default readMultipart;
