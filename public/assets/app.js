// app.js — SPA 入口：路由表、导航高亮、视图生命周期。
// 后端 static.mjs 对未知路径回落 index.html，因此 History API 前端路由可直接深链。
import { qs, clear, h, icon } from './dom.js';
import { initShell, setRouteLabel } from './shell.js';
import uploadView from './views/upload.view.js';
import taskDetailView from './views/task-detail.view.js';
import resultsView from './views/results.view.js';
import enginesView from './views/engines.view.js';
import settingsView from './views/settings.view.js';
import logsView from './views/logs.view.js';
import notFoundView from './views/notfound.view.js';

const ROUTES = [
  { re: /^\/$/, names: [], view: uploadView, label: '溯源工作台', nav: '/' },
  { re: /^\/tasks\/([^/]+)\/frames\/([^/]+)$/, names: ['id', 'frameId'], view: taskDetailView, label: '帧溯源详情' },
  { re: /^\/tasks\/([^/]+)$/, names: ['id'], view: taskDetailView, label: '任务详情' },
  { re: /^\/results$/, names: [], view: resultsView, label: '结果总览', nav: '/results' },
  { re: /^\/engines$/, names: [], view: enginesView, label: '引擎诊断', nav: '/engines' },
  { re: /^\/logs$/, names: [], view: logsView, label: '运行日志', nav: '/logs' },
  { re: /^\/settings$/, names: [], view: settingsView, label: '设置', nav: '/settings' },
];

let cleanup = null;

function matchRoute(pathname) {
  for (const route of ROUTES) {
    const m = route.re.exec(pathname);
    if (!m) continue;
    const params = {};
    m.slice(1).forEach((v, i) => { params[route.names[i] || `p${i}`] = decodeURIComponent(v); });
    return { route, params };
  }
  return null;
}

function highlightNav(navPath) {
  for (const item of document.querySelectorAll('.nav-item')) {
    const active = navPath && item.dataset.route === navPath;
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
}

function render() {
  const root = qs('#view-root');
  if (!root) return;
  const matched = matchRoute(location.pathname);
  const { route, params } = matched || { route: null, params: {} };
  const view = route ? route.view : notFoundView;
  const label = route ? route.label : '页面不存在';

  if (typeof cleanup === 'function') { try { cleanup(); } catch (err) { console.error('[cleanup]', err); } }
  cleanup = null;
  clear(root);
  root.classList.remove('view-enter');
  void root.offsetWidth;
  root.classList.add('view-enter');

  document.title = `${label} · 反向视频溯源`;
  setRouteLabel(label);
  highlightNav(route ? route.nav : null);
  qs('#main')?.scrollTo?.({ top: 0 });

  const ctx = {
    params,
    query: new URLSearchParams(location.search),
    navigate: (to) => { if (to !== `${location.pathname}${location.search}`) history.pushState({}, '', to); render(); },
    replace: (to) => { history.replaceState({}, '', to); },
  };
  try {
    const ret = view.render(root, ctx);
    cleanup = typeof ret === 'function' ? ret : null;
  } catch (err) {
    console.error('[view]', err);
    clear(root);
    root.appendChild(h('div', { class: 'err-block', role: 'alert' },
      h('div', { class: 'err-block__title' }, icon('x-circle', 18), h('span', { text: '视图渲染失败' })),
      h('p', { class: 'muted', text: err && err.message ? err.message : String(err) })));
  }
}

// 同源站内链接统一走 pushState，避免整页刷新丢状态。
document.addEventListener('click', (ev) => {
  if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
  const a = ev.target instanceof Element ? ev.target.closest('a[href]') : null;
  if (!a) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || a.target === '_blank' || a.hasAttribute('download')) return;
  ev.preventDefault();
  if (url.pathname === location.pathname && url.search === location.search) return;
  history.pushState({}, '', url.pathname + url.search);
  render();
});

window.addEventListener('popstate', render);
initShell();
render();
