// store.js — 全局状态与跨组件事件总线。零依赖。
// 规则：跨组件通信一律走 bus，不靠 DOM 事件乱传；视图只读自己需要切片。

function createBus() {
  const listeners = new Map();
  return {
    on(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, new Set());
      listeners.get(evt).add(fn);
      return () => listeners.get(evt)?.delete(fn);
    },
    emit(evt, payload) {
      for (const fn of listeners.get(evt) || []) {
        try { fn(payload); } catch (err) { console.error('[bus]', evt, err); }
      }
    },
  };
}

function createStore(initial) {
  let state = { ...initial };
  const subs = new Set();
  return {
    get: () => state,
    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      let changed = false;
      for (const [k, v] of Object.entries(next)) {
        if (state[k] !== v) { changed = true; break; }
      }
      if (!changed) return state;
      state = { ...state, ...next };
      for (const fn of subs) fn(state);
      return state;
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

export const bus = createBus();

export const EVT = {
  health: 'health',        // 健康快照更新
  net: 'net',              // 网络健康变化
  settings: 'settings',    // 设置更新
  taskChanged: 'task',     // 某任务状态变化（payload: taskId）
  theme: 'theme',
};

const THEME_KEY = 'rvs.theme';

function readTheme() {
  try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
}

export const store = createStore({
  theme: readTheme(),          // 'dark' 默认；浅色为预留寄存器，切换器仅在设置页暴露
  health: null,                // GET /api/health 快照
  online: true,                // 到本地服务的网络是否健康
  engines: [],                 // GET /api/engines 快照
  settings: null,              // 可写设置（PUT /api/settings 的载荷形态）
  taskCount: null,             // 任务总数（工作台摘要用）
});

export function setTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem(THEME_KEY, next); } catch { /* 隐私模式下忽略 */ }
  store.set({ theme: next });
  bus.emit(EVT.theme, next);
}

/** 任务状态变化广播：让列表页与详情页同步刷新。 */
export const notifyTaskChanged = (taskId) => bus.emit(EVT.taskChanged, taskId);
