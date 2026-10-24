// 静态文件 serve：public/ 前端资源 + 自产帧 /frames/<task_id>/<file> 与缩略图 /thumbs/<file>。
import fs from 'node:fs';
import path from 'node:path';
import { sendBuffer, sendText } from './json.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

// 目录穿越防护：解析后的绝对路径必须仍在根目录内。
export function safeJoin(rootDir, ...segments) {
  const resolved = path.resolve(rootDir, ...segments.map((s) => String(s || '')));
  const root = path.resolve(rootDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

export function createStaticHandler({ staticDir, framesDir, thumbsDir }) {
  function serveFile(req, res, filePath) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      sendText(res, 404, 'Not Found');
      return true;
    }
    if (stat.isDirectory()) {
      sendText(res, 404, 'Not Found');
      return true;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const body = fs.readFileSync(filePath);
    sendBuffer(res, 200, body, {
      'Content-Type': type,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'Content-Length': body.length,
    });
    return true;
  }

  return function handle(req, res, pathname) {
    if (pathname.startsWith('/frames/')) {
      const rest = pathname.slice('/frames/'.length);
      const filePath = safeJoin(framesDir, rest);
      if (!filePath) {
        sendText(res, 400, 'Bad path');
        return true;
      }
      return serveFile(req, res, filePath);
    }
    if (pathname.startsWith('/thumbs/')) {
      const rest = pathname.slice('/thumbs/'.length);
      const filePath = safeJoin(thumbsDir, rest);
      if (!filePath) {
        sendText(res, 400, 'Bad path');
        return true;
      }
      return serveFile(req, res, filePath);
    }
    // API 前缀未命中任何路由：交回 app.mjs 输出 404 JSON 信封，禁被 SPA 兜底吞成 HTML
    // （前端 fetch 到错误端点会拿到 HTML，.json() 直接崩——2026-10-24 live 验证查出）。
    if (pathname === '/api' || pathname.startsWith('/api/')) return false;
    if (!staticDir) return false;
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = safeJoin(staticDir, relative);
    if (!filePath) {
      sendText(res, 400, 'Bad path');
      return true;
    }
    if (!fs.existsSync(filePath)) {
      // 前端为单页应用，未知路径回落到 index.html 由前端路由处理。
      const index = path.join(staticDir, 'index.html');
      if (fs.existsSync(index)) return serveFile(req, res, index);
      sendText(res, 404, 'Not Found');
      return true;
    }
    return serveFile(req, res, filePath);
  };
}
