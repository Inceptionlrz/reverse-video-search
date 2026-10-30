// shell.js — 应用外壳的常驻部件：引擎健康条、网络指示、隐私浮层、状态栏。
// 这些部件跨视图存活，不随路由重建；轮询在此统一收口。
import { h, icon, popover, qs } from './dom.js';
import { api, errText, onNetworkChange } from './api.js';
import { store, bus, EVT, setTheme } from './store.js';
import { fmtUptime, fmtLatency, engineLabel } from './format.js';

let routeLabel = '溯源工作台';

export function setRouteLabel(label) {
  routeLabel = label;
  renderStatusCenter();
}

function engineTone(e) {
  if (!e.enabled) return 'disabled';
  if (e.circuit_open) return 'throttled';
  if (e.availability && e.availability.deeplink === 'unavailable' && e.availability.bridge === 'unavailable' && e.availability.upload === 'unavailable') return 'zero';
  return 'ok';
}

function renderEngineStrip(health) {
  const host = qs('#engine-strip');
  if (!host) return;
  // 引擎名包一层 span：窄屏只留状态圆点、隐去文字。
  // 不加这层壳就只能整条 overflow 裁掉，实测 320px 下会切出 "Googl" "Yande" "Bin"
  // 这种半截词——既不截断语义也不好看。留圆点仍能看到各引擎健康色。
  host.replaceChildren(...(health?.engines || []).map((e) => h('button', {
    class: 'chip', type: 'button', title: `${engineLabel(e.id)}：${e.enabled ? (e.circuit_open ? '熔断中' : '在线') : '已停用'}`,
    onclick: () => { location.assign('/engines'); },
  }, h('span', { class: `dot dot--sm dot--${engineTone(e)}` }),
     h('span', { class: 'chip__label', text: engineLabel(e.id) }))));
}

function renderNetIndicator(online) {
  const node = qs('#net-indicator');
  if (node) node.hidden = online;
}

function renderStatusLeft(health) {
  const host = qs('#status-left');
  if (!host) return;
  if (!health) { host.replaceChildren(h('span', { class: 'statusbar__item' }, icon('loader', 13, 'btn__spin'), '正在连接本地服务')); return; }
  const ff = health.ffmpeg || {};
  host.replaceChildren(
    h('span', { class: 'statusbar__item', title: ff.version_line || ff.error || '' },
      icon(ff.available ? 'check-circle' : 'x-circle', 13), `ffmpeg ${ff.available ? '可用' : '不可用'}`),
    // opt 类：窄屏下隐藏。状态栏是 nowrap 等宽文本条，三项合计 362px 会把
    // 320px 视口的移动端布局视口撑到 362（底栏导航跟着变宽、整页横滚）。
    // SQLite 状态在手机上最不具操作性，让位给 ffmpeg 与网络态。
    h('span', { class: 'statusbar__item statusbar__item--opt', title: health.db?.path || '' }, icon(health.db?.ok ? 'database' : 'x-circle', 13), `SQLite ${health.db?.ok ? '正常' : '异常'}`),
    h('span', { class: 'statusbar__item' }, icon(health.offline ? 'wifi-off' : 'globe', 13), health.offline ? '离线模式' : (health.proxy?.configured ? '经本地代理出站' : '直连出站')));
}

function renderStatusCenter() {
  const host = qs('#status-center');
  if (!host) return;
  const engines = store.get().engines || [];
  const on = engines.filter((e) => e.enabled && !e.circuit_open).length;
  host.replaceChildren(h('span', { class: 'statusbar__item', text: routeLabel }),
    engines.length ? h('span', { class: 'statusbar__item', text: `引擎 ${on}/${engines.length}` }) : null);
}

function renderStatusRight(health) {
  const host = qs('#status-right');
  if (!host) return;
  host.replaceChildren(
    h('span', { class: 'statusbar__item' }, icon('clock', 13), `运行 ${fmtUptime(health?.uptime_ms ?? 0)}`),
    h('span', { class: 'statusbar__item' }, icon('lock', 13), '仅本机访问'));
}

const PRIVACY_BODY = () => h('div', {},
  h('div', { class: 'popover__title' }, icon('shield', 16), '帧的去向，由你逐次决定'),
  h('p', { class: 'popover__text', text: '抽帧、去重、本地哈希全部在本机进程内完成。只有你在任务里点了「确认外发」，帧图才会以 HTTP 请求发出去。' }),
  h('ul', { class: 'popover__list' },
    h('li', { text: '外发前必须勾选引擎范围，每次任务单独生效。' }),
    h('li', { text: '图床桥接需单独勾选并选站点，未勾选时不会上传。' }),
    h('li', { text: '运行日志只写本机内存环形缓冲，重启即清空。' }),
    h('li', { text: '断网或离线模式下，任何请求都不会发出。' })));

function bindPrivacyButton() {
  const btn = qs('#privacy-btn');
  if (!btn) return;
  let ui = null;
  btn.addEventListener('click', () => {
    if (ui) { ui.close(); ui = null; return; }
    ui = popover(btn, PRIVACY_BODY());
    const orig = ui.close;
    ui.close = () => { orig(); ui = null; };
  });
}

async function refreshHealth() {
  try {
    const health = await api.health();
    store.set({ health });
    bus.emit(EVT.health, health);
    renderEngineStrip(health);
    renderStatusLeft(health);
    renderStatusRight(health);
  } catch (err) {
    store.set({ health: null });
    renderStatusLeft(null);
    if (!store.get().online) return;
    console.warn('[health]', errText(err));
  }
}

async function refreshEngines() {
  try {
    const data = await api.engines();
    store.set({ engines: data.engines || [] });
    renderStatusCenter();
  } catch { /* 引擎条静默失败，状态栏保留上一次快照 */ }
}

/** 外壳初始化：主题、隐私浮层、网络指示、健康与引擎轮询。 */
export function initShell() {
  document.documentElement.setAttribute('data-theme', store.get().theme);
  bindPrivacyButton();
  onNetworkChange((online) => { store.set({ online }); renderNetIndicator(online); });
  renderNetIndicator(store.get().online);
  void refreshHealth();
  void refreshEngines();
  setInterval(refreshHealth, 15000);
  setInterval(refreshEngines, 20000);
  window.addEventListener('online', () => void refreshHealth());
  window.addEventListener('offline', () => store.set({ online: false }));
  bus.on(EVT.theme, () => { /* 主题由 setTheme 直接落 data-theme，这里只留钩子 */ });
}

export { setTheme };
