// manual-runbook.view.js — 手动跑腿工作台。
//
// 为什么需要它：Google Lens 的自动链路走不通——它的结果页是纯 JS 应用外壳
// （实测：POST /v3/upload → 303 → 结果页 title="Google Search"，AF_initDataCallback
// 0 命中、/url?q= 0 命中，数据全部由客户端 JS 渲染，HTTP 层抓不到。带 cookie jar
// 复测过，结论不变，证据见 scripts/probe/18-lens-cookie.mjs 与 out-H-*.html）。
// 这一路只能由人把帧贴到引擎上传页。既然必须手动，就把手动的成本压到最低：
//   - 「复制帧图片」：把帧写进系统剪贴板，到 Lens 上传页按 Ctrl+V 即可，
//     不必开文件对话框逐层找文件；
//   - 「拖到引擎页」：缩略图可直接拖到引擎上传区，是真实的 File 拖放而非文本；
//   - 一屏聚合所有待手动组合、按帧分组，不用逐个翻条目。
//
// 能力边界（如实说明，不夸大）：本环境没有浏览器，粘贴与拖放到 lens.google.com
// 的兼容性**未经实测**。两条路都提供，任一生效即可显著省事；都不生效时退回
// 「复制帧路径」手动选择文件。
import { h, icon, toast, modal, safeHttpUrl } from '../dom.js';
import { fmtDuration, engineLabel } from '../format.js';
import { copyWithToast } from './shared.view.js';

/** 帧图缓存：previewUrl -> File。拖放必须在 dragstart 里同步交出 File，来不及临时 fetch。 */
const fileCache = new Map();

async function fetchFrameFile(previewUrl, fileName) {
  if (fileCache.has(previewUrl)) return fileCache.get(previewUrl);
  const res = await fetch(previewUrl, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`读取帧失败：HTTP ${res.status}`);
  const blob = await res.blob();
  const file = new File([blob], fileName || 'frame.jpg', { type: blob.type || 'image/jpeg' });
  fileCache.set(previewUrl, file);
  return file;
}

/** 把帧图片写进系统剪贴板，供目标上传页 Ctrl+V。 */
async function copyFrameImage(previewUrl, fileName, label) {
  try {
    const file = await fetchFrameFile(previewUrl, fileName);
    // Chrome 的 ClipboardItem 对 image/png 支持最稳，先过一道 canvas；失败就退回原图字节。
    let blob = file;
    try {
      const bmp = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      canvas.getContext('2d').drawImage(bmp, 0, 0);
      blob = await new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas 转 PNG 失败'))), 'image/png');
      });
    } catch { /* 转不了就用原始 JPEG 字节，多数引擎照样收 */ }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast(`${label}图片已复制，到上传页按 Ctrl+V 即可`, 'ok');
  } catch (err) {
    toast(`复制图片失败：${err.message || err}`, 'error');
  }
}

/** 让缩略图可拖拽：dragstart 时交出真实 File，目标页的文件上传区会当成文件放入。 */
function makeDraggable(node, previewUrl, fileName) {
  if (!previewUrl) return;
  node.draggable = true;
  node.title = '可拖到引擎上传页';
  node.addEventListener('dragstart', (ev) => {
    const file = fileCache.get(previewUrl);
    if (!file) {
      // 缓存未就绪时退化为拖链接，至少不抛错；下次拖即可命中缓存
      ev.dataTransfer.setData('text/plain', previewUrl);
      return;
    }
    ev.dataTransfer.items.add(file);
    ev.dataTransfer.effectAllowed = 'copy';
  });
}

/** 单个「帧 × 引擎」组合的操作簇。 */
function manualRow(analysis, frame) {
  const url = safeHttpUrl(analysis.manual_url);
  const previewUrl = frame?.preview_url || null;
  const fileName = frame?.file_name || `frame-${analysis.frame_id}.jpg`;
  return h('div', { class: 'consent-row' },
    icon('hand', 14, 'muted'),
    h('span', { class: 'grow', text: engineLabel(analysis.provider) }),
    url ? h('a', { class: 'btn btn--secondary btn--sm', href: url, target: '_blank', rel: 'noreferrer noopener' }, icon('external-link', 14), '打开发引擎上传页') : null,
    previewUrl ? h('button', {
      class: 'btn btn--primary btn--sm', type: 'button',
      onclick: () => copyFrameImage(previewUrl, fileName, `第 ${frame?.seq ?? '?'} 帧`),
    }, icon('copy', 14), '复制帧图片') : null,
    h('button', {
      class: 'btn btn--ghost btn--sm', type: 'button',
      onclick: () => copyWithToast(analysis.manual_path || '', '帧路径'),
    }, icon('copy', 14), '复制帧路径'));
}

/**
 * 手动跑腿工作台。analyses 里 status==='manual' 的项会被按帧聚合。
 * frames 用于取 preview_url（浏览器可直接 fetch 到帧图字节）。
 */
export function openManualRunbook({ analyses, frames = [] }) {
  const manual = (analyses || []).filter((a) => a.status === 'manual');
  const byFrame = new Map();
  for (const a of manual) {
    if (!byFrame.has(a.frame_id)) byFrame.set(a.frame_id, []);
    byFrame.get(a.frame_id).push(a);
  }
  const frameById = new Map((frames || []).map((f) => [f.id, f]));

  // 打开工作台时就把帧图预热进缓存：拖放要同步交 File，不能等 dragstart 里再 fetch。
  const warming = [];
  for (const [frameId, items] of byFrame) {
    const frame = frameById.get(frameId);
    if (frame?.preview_url) {
      warming.push(fetchFrameFile(frame.preview_url, frame.file_name).catch(() => {}));
    }
  }
  Promise.all(warming);

  const groups = [...byFrame.entries()].map(([frameId, items]) => {
    const frame = frameById.get(frameId) || {};
    const previewUrl = frame.preview_url || null;
    const thumb = previewUrl
      ? h('img', { class: 'runbook__thumb', src: previewUrl, alt: `第 ${frame.seq ?? '?'} 帧`, width: 96, height: 96 })
      : h('div', { class: 'runbook__thumb runbook__thumb--empty' }, icon('frame', 20, 'muted'));
    if (previewUrl) makeDraggable(thumb, previewUrl, frame.file_name || `frame-${frameId}.jpg`);
    return h('div', { class: 'runbook__group' },
      thumb,
      h('div', { class: 'grow stack stack--tight' },
        h('div', { class: 'row row--tight' },
          h('strong', { text: `第 ${frame.seq ?? '?'} 帧` }),
          h('span', { class: 'muted', text: fmtDuration(frame.time_ms) }),
          previewUrl ? h('span', { class: 'muted', text: '缩略图可拖到引擎上传页' }) : null),
        ...items.map((a) => manualRow(a, frame))));
  });

  const allPaths = manual.map((a) => a.manual_path).filter(Boolean).join('\n');
  const ui = modal({
    title: '手动跑腿工作台',
    sub: '这些帧 × 引擎组合没走通自动链路，改为由你把帧贴到引擎上传页。',
    iconName: 'hand',
    wide: true,
    dismissable: true,
    body: [
      h('div', { class: 'consent-ack' }, icon('info', 14),
        h('span', { text: 'Google Lens 的结果页由浏览器 JS 渲染，本机 HTTP 层拿不到（实测过，见 scripts/probe/18-lens-cookie.mjs）——所以这一路只能手动。用「复制帧图片」省掉找文件：点一下，切到引擎上传页按 Ctrl+V。' })),
      groups.length
        ? h('div', { class: 'stack' }, ...groups)
        : h('p', { class: 'muted', text: '当前没有待手动的组合。' }),
    ],
    actions: [
      allPaths ? h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => copyWithToast(allPaths, '全部帧路径') }, icon('copy', 14), '复制全部帧路径') : null,
      h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => ui.close() }, '知道了'),
    ].filter(Boolean),
  });
  return ui;
}
