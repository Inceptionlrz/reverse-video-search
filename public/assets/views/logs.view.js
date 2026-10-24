// logs.view.js — 运行日志：等宽、按级别着色、可过滤、可暂停自动刷新。
// 状态覆盖：Loading / Empty / Error / Degraded / Populated / Edge / Offline。
import { h, icon, qs } from '../dom.js';
import { api, errText } from '../api.js';
import { fmtClock, fmtInt, LOG_LEVEL_TEXT } from '../format.js';
import { loadingBlock, errorBlock, banner, createPoller } from './shared.view.js';

const LEVELS = ['', 'debug', 'info', 'warn', 'error'];
const CATEGORIES = ['', 'task', 'frame', 'analysis', 'engine', 'result', 'settings', 'server', 'http'];

export default {
  render(root, ctx) {
    void ctx;
    const state = { items: [], total: 0, loading: true, error: null, auto: true, filters: { level: '', category: '', q: '' } };
    let timer = 0;

    root.append(
      h('div', { class: 'page-head' },
        h('div', { class: 'grow' },
          h('h1', { class: 'page-title', text: '运行日志' }),
          h('p', { class: 'page-sub', text: '内存环形缓冲，已做字段脱敏。重启服务即清空，适合定位某一次请求为什么降级。' }))),
      h('div', { id: 'degraded-slot', class: 'stack', style: { marginBottom: 'var(--space-3)' } }),
      h('div', { class: 'panel' },
        h('div', { class: 'logs-toolbar', id: 'logs-toolbar' }),
        h('div', { id: 'logs-body' }, loadingBlock('正在读取日志', 8)),
        h('div', { class: 'panel__head', style: { borderTop: '1px solid var(--divider)', borderBottom: '0' } },
          h('span', { class: 'grow muted', id: 'logs-count', style: { fontSize: 'var(--text-sm)' } }),
          h('label', { class: 'switch' },
            h('input', { type: 'checkbox', checked: true, onchange: (ev) => { state.auto = ev.target.checked; if (state.auto) void load(); } }),
            h('span', { class: 'switch__track' }), h('span', { class: 'switch__text', text: '自动刷新' })))));

    renderToolbar();
    void load();
    const stop = createPoller(() => { if (state.auto) void load({ silent: true }); }, () => 5000);
    return stop;

    async function load({ silent = false } = {}) {
      if (!silent) { state.loading = true; renderBody(); }
      try {
        const [data, health] = await Promise.all([
          api.logs({ ...state.filters, limit: 200 }),
          api.health().catch(() => null),
        ]);
        state.items = data.items || []; state.total = data.total ?? state.items.length;
        state.loading = false; state.error = null;
        renderDegraded(health);
        renderCount();
        renderBody();
      } catch (err) {
        state.loading = false; state.error = err;
        if (!silent) renderBody(err);
      }
    }

    function renderDegraded(health) {
      const slot = qs('#degraded-slot');
      if (!slot) return;
      const nodes = [];
      if (health?.offline) nodes.push(banner({ tone: 'warn', title: '当前离线模式', detail: '发生了什么：服务以离线模式启动。已切到什么：日志里不会出现任何外网请求记录。你能做什么：重启服务关闭离线开关。' }));
      const errors = state.items.filter((l) => l.level === 'error').length;
      if (errors) nodes.push(banner({ tone: 'info', title: `最近 ${errors} 条错误日志`, detail: '已切到什么：错误已按 request_id 归档在下方。你能做什么：复制 request_id 给排障，或在结果页按任务反查。' }));
      slot.replaceChildren(...nodes);
    }

    function renderToolbar() {
      const bar = qs('#logs-toolbar');
      if (!bar) return;
      const level = h('select', { class: 'select', style: { width: '120px' }, onchange: (ev) => { state.filters.level = ev.target.value; void load(); } },
        ...LEVELS.map((v) => h('option', { value: v, text: v ? LOG_LEVEL_TEXT[v] : '全部级别' })));
      const category = h('select', { class: 'select', style: { width: '130px' }, onchange: (ev) => { state.filters.category = ev.target.value; void load(); } },
        ...CATEGORIES.map((v) => h('option', { value: v, text: v || '全部分类' })));
      const q = h('input', { class: 'input', type: 'search', placeholder: '搜 message / event / task_id', style: { width: '240px' }, oninput: (ev) => { state.filters.q = ev.target.value; schedule(); } });
      bar.replaceChildren(
        h('div', { class: 'toolbar__group' }, icon('filter', 16, 'muted'), level, category),
        h('span', { class: 'toolbar__sep' }),
        h('div', { class: 'toolbar__group' }, icon('search', 16, 'muted'), q),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => void load() }, icon('refresh', 14), '立即刷新'));
    }

    function schedule() { clearTimeout(timer); timer = setTimeout(() => void load(), 350); }

    function renderCount() {
      const el = qs('#logs-count');
      if (el) el.textContent = `显示 ${fmtInt(state.items.length)} 条，缓冲区共 ${fmtInt(state.total)} 条`;
    }

    function renderBody(err) {
      const body = qs('#logs-body');
      if (!body) return;
      if (err) { body.replaceChildren(errorBlock(err, () => load())); return; }
      if (state.loading) { body.replaceChildren(loadingBlock('正在读取日志', 8)); return; }
      if (!state.items.length) {
        body.replaceChildren(h('div', { class: 'empty' },
          icon('list', 40, 'empty__icon'),
          h('p', { class: 'empty__title', text: '当前过滤条件下没有日志' }),
          h('p', { class: 'empty__desc', text: '缓冲区可能还没写入这个级别，或关键词不匹配。清空过滤条件再看一次。' })));
        return;
      }
      body.replaceChildren(h('div', { class: 'logs', role: 'log', 'aria-label': '运行日志' }, ...state.items.map(logRow)));
    }

    function logRow(l) {
      const fields = l.fields && Object.keys(l.fields).length ? JSON.stringify(l.fields) : '';
      return h('div', { class: 'log-row' },
        h('span', { class: 'log-row__ts', text: fmtClock(l.ts) }),
        h('span', { class: `log-row__lvl log-row__lvl--${l.level}`, text: LOG_LEVEL_TEXT[l.level] || l.level }),
        h('span', { class: 'log-row__cat', text: l.category || '—' }),
        h('span', { class: 'log-row__msg' },
          h('span', { text: l.message || '—' }),
          l.event ? h('span', { class: 'muted', text: ` · ${l.event}` }) : null,
          l.request_id ? h('span', { class: 'muted', text: ` · req ${l.request_id}` }) : null,
          l.task_id ? h('span', { class: 'muted', text: ` · task ${l.task_id}` }) : null,
          fields ? h('span', { class: 'muted', text: ` · ${fields}` }) : null));
    }
  },
};
