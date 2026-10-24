// dom.js — 原生 DOM 构建与交互原语。零依赖、零框架。
// 约束：不使用 innerHTML 拼接业务文案（防 XSS 与字符转义漏项）；文案一律走 text 属性。
import { SPRITE } from './sprite.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// 图标 sprite 在模块求值期注入：早于任何视图渲染，保证首帧即可用 <use> 引用。
// 守卫顺序不可交换：typeof 检查必须写在左侧，否则无 DOM 的环境（Node 测试里
// import 本模块）会在求值 document.getElementById 时就抛 ReferenceError，
// 短路根本走不到右侧的守卫。
if (typeof document !== 'undefined' && !document.getElementById('rvs-sprite-host')) {
  document.body.insertAdjacentHTML('afterbegin', SPRITE.replace('<svg ', '<svg id="rvs-sprite-host" '));
}

function applyProps(node, props) {
  if (!props) return;
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'class' || key === 'className') {
      node.classList.add(...String(value).split(/\s+/).filter(Boolean));
    } else if (key === 'style') {
      Object.assign(node.style, value);
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (['value', 'checked', 'disabled', 'hidden', 'selected', 'readOnly'].includes(key)) {
      node[key] = value;
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
}

function appendChildren(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** hyperscript：h('div', {class:'x', onclick:fn}, '文本', [child, ...]) */
export function h(tag, props, ...children) {
  const node = document.createElement(tag);
  applyProps(node, props);
  appendChildren(node, children);
  return node;
}

/** 带命名空间的 SVG 元素（图标用）。 */
export function svgEl(tag, props, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  applyProps(node, props);
  appendChildren(node, children);
  return node;
}

/** 项目锁定图标库的内联 sprite 引用（rvs-icon-{name}，24 viewBox，1.5 描边，currentColor）。 */
export function icon(name, size = 20, cls = '') {
  const svg = svgEl('svg', { width: size, height: size, 'aria-hidden': 'true', focusable: 'false', class: cls || null });
  svg.appendChild(svgEl('use', { href: `#rvs-icon-${name}` }));
  return svg;
}

export const qs = (sel, base = document) => base.querySelector(sel);
export const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };

/** 骨架屏：n 条等高占位。 */
export const skeletonRows = (n = 6, variant = 'sk--row') =>
  h('div', { class: 'stack', 'aria-hidden': 'true' }, Array.from({ length: n }, () => h('div', { class: `sk ${variant}` })));

/** 结果行骨架（含缩略图占位）。 */
export const skeletonResults = (n = 5) =>
  h('div', { class: 'stack', 'aria-hidden': 'true' }, Array.from({ length: n }, () =>
    h('div', { class: 'result' }, h('div', { class: 'result__thumb sk' }), h('div', { class: 'result__body' },
      h('div', { class: 'sk sk--line', style: { width: '62%' } }),
      h('div', { class: 'sk sk--line', style: { width: '38%' } })), h('div', { class: 'score-cell' },
      h('div', { class: 'sk sk--line', style: { width: '96px', marginLeft: 'auto' } })))));

const TOAST_ICON = { ok: 'check-circle', warn: 'alert-triangle', error: 'x-circle', info: 'info' };

/** 轻提示。kind: ok | warn | error | info。 */
export function toast(text, kind = 'info', ms = 3600) {
  const root = qs('#toast-root');
  if (!root) return;
  let timer = 0;
  const close = () => {
    clearTimeout(timer);
    node.classList.add('toast__leave');
    node.addEventListener('animationend', () => node.remove(), { once: true });
  };
  const node = h('div', { class: `toast toast--${kind}`, role: 'status' },
    icon(TOAST_ICON[kind] || 'info', 18, 'toast__icon'),
    h('span', { class: 'toast__text', text }),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': '关闭提示', onclick: close }, icon('x', 16)));
  root.appendChild(node);
  timer = setTimeout(close, ms);
  return close;
}

/** 警示级模态。返回 { close }；Esc 与点遮罩可关（dismissable:false 时不可）。 */
export function modal({ title, sub = '', iconName = 'info', wide = false, dismissable = true, body = [], actions = [], onClose }) {
  const root = qs('#modal-root');
  let lastFocus = document.activeElement;
  const close = () => {
    document.removeEventListener('keydown', onKey);
    node.remove();
    if (lastFocus instanceof HTMLElement) lastFocus.focus();
    if (onClose) onClose();
  };
  const onKey = (ev) => {
    if (ev.key === 'Escape' && dismissable) close();
    if (ev.key === 'Tab') trapFocus(ev, node);
  };
  const cancelBtn = h('button', { class: 'btn btn--ghost', type: 'button', onclick: close }, '关闭');
  const node = h('div', { class: 'modal-backdrop', role: 'presentation' },
    h('div', { class: `modal${wide ? ' modal--wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal__head' }, icon(iconName, 20, 'modal__icon'),
        h('div', { class: 'grow' }, h('h2', { class: 'modal__title', text: title }), sub ? h('p', { class: 'modal__sub', text: sub }) : null),
        dismissable ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': '关闭对话框', onclick: close }, icon('x', 18)) : null),
      h('div', { class: 'modal__body' }, body),
      h('div', { class: 'modal__foot' }, dismissable ? cancelBtn : null, actions)));
  node.addEventListener('mousedown', (ev) => { if (dismissable && ev.target === node) close(); });
  root.appendChild(node);
  document.addEventListener('keydown', onKey);
  const focusable = node.querySelector('input, button, select, textarea, a[href]');
  if (focusable instanceof HTMLElement) focusable.focus();
  return { close, node };
}

function trapFocus(ev, container) {
  const items = [...container.querySelectorAll('button, [href], input, select, textarea')].filter((n) => !n.disabled && n.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
  else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
}

/** 锚点 popover：点外部或 Esc 关闭。 */
export function popover(anchor, contentNode, { align = 'right' } = {}) {
  const root = qs('#popover-root');
  const close = () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); node.remove(); anchor.setAttribute('aria-expanded', 'false'); };
  const onDown = (ev) => { if (!node.contains(ev.target) && ev.target !== anchor) close(); };
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  const node = h('div', { class: 'popover', role: 'dialog', style: { top: '100%', right: align === 'right' ? '0' : 'auto', left: align === 'left' ? '0' : 'auto' } }, contentNode);
  anchor.setAttribute('aria-expanded', 'true');
  anchor.parentElement.style.position = 'relative';
  anchor.parentElement.appendChild(node);
  document.addEventListener('mousedown', onDown);
  document.addEventListener('keydown', onKey);
  return { close, node };
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** 只允许 http/https 外链，其他协议一律拒绝（防 javascript: 等）。 */
export function safeHttpUrl(url) {
  try {
    const u = new URL(String(url || ''), location.origin);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** 用 fetch Response 触发浏览器下载。 */
export function downloadResponse(res, filename) {
  return res.blob().then((blob) => {
    const href = URL.createObjectURL(blob);
    const a = h('a', { href, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 4000);
  });
}
