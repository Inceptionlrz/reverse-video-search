// results.view.js — 结果总览：跨任务的结果集，双轨分数 + 筛选 + 导出。
// 状态覆盖：Loading / Empty / Error / Degraded / Populated / Edge / Offline。
import { h, icon, qs, modal } from '../dom.js';
import { api, errText } from '../api.js';
import { fmtInt, engineLabel } from '../format.js';
import {
  emptyBlock, errorBlock, loadingBlock, banner, resultRow, resultsSkeleton,
  exportModal, scoreLegend, createPoller, copyWithToast,
} from './shared.view.js';
import { resultInspector } from './inspector.view.js';

const SORTS = [
  { v: 'sort_score', t: '排序分' },
  { v: 'local_hash_similarity', t: '本地哈希相似度' },
  { v: 'hits', t: '命中次数' },
  { v: 'discovered', t: '发现时间' },
];

export default {
  render(root, ctx) {
    const state = {
      items: [], total: 0, engines: [], loading: true, error: null,
      filters: {
        q: ctx.query.get('q') || '',
        domain: ctx.query.get('domain') || '',
        provider: ctx.query.get('provider') || '',
        min_score: ctx.query.get('min_score') || '',
        sort: ctx.query.get('sort') || 'sort_score',
        order: ctx.query.get('order') || 'desc',
        task_id: ctx.query.get('task_id') || '',
      },
      offset: 0,
    };
    let timer = 0;

    root.append(
      h('div', { class: 'page-head' },
        h('div', { class: 'grow' },
          h('h1', { class: 'page-title', text: '结果总览' }),
          h('p', { class: 'page-sub', id: 'results-sub', text: '所有任务去重后的结果。同一个来源页被多帧多引擎命中会合并成一条，命中次数越多越值得先看。' })),
        h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => exportModal({ filters: state.filters }) }, icon('download', 16), '导出')),
      h('div', { id: 'degraded-slot', class: 'stack', style: { marginBottom: 'var(--space-3)' } }),
      h('div', { id: 'legend-slot' }, scoreLegend()),
      h('div', { class: 'panel', style: { marginTop: 'var(--space-4)' } },
        h('div', { class: 'toolbar', id: 'results-toolbar' }),
        h('div', { id: 'summary-slot', style: { padding: 'var(--space-3)' } }),
        h('div', { id: 'results-body' }, loadingBlock('正在汇总结果', 5)),
        h('div', { class: 'panel__head', id: 'pager', style: { borderTop: '1px solid var(--divider)', borderBottom: '0' } })));

    void load();
    const stop = createPoller(() => load({ silent: true }), () => 15000);
    return stop;

    async function load({ silent = false } = {}) {
      if (!silent) { state.loading = true; renderResults(); }
      try {
        const [data, engines, health] = await Promise.all([
          api.listResults({ ...state.filters, limit: 30, offset: state.offset }),
          api.engines().catch(() => ({ engines: [] })),
          api.health().catch(() => null),
        ]);
        state.items = data.items || []; state.total = data.total ?? state.items.length;
        state.engines = engines.engines || []; state.loading = false; state.error = null;
        renderDegraded(health);
        renderToolbar();
        renderSummary();
        renderResults();
        renderPager();
      } catch (err) {
        state.loading = false; state.error = err;
        if (!silent) renderResults(err);
      }
    }

    function renderDegraded(health) {
      const slot = qs('#degraded-slot');
      if (!slot) return;
      const nodes = [];
      if (health?.offline) nodes.push(banner({ tone: 'warn', title: '当前离线模式', detail: '发生了什么：服务以离线模式启动。已切到什么：只读本地已入库的结果。你能做什么：重启服务并关闭离线开关后可继续检索。' }));
      const disabled = state.engines.filter((e) => !e.enabled || e.circuit_open);
      if (disabled.length) nodes.push(banner({ tone: 'info', title: `${disabled.length} 个引擎当前不参与检索`, detail: `已切到什么：${disabled.map((e) => engineLabel(e.id)).join('、')} 已停用或熔断中，新检索不会用到它们。你能做什么：去引擎诊断页恢复启停。` }));
      const noHash = state.items.length && state.items.every((r) => r.local_hash_similarity === null || r.local_hash_similarity === undefined);
      if (noHash) nodes.push(banner({ tone: 'info', title: '本地哈希相似度全部为「未提供」', detail: '发生了什么：默认不下载结果缩略图。已切到什么：本地哈希列显示「—」。你能做什么：在设置页打开「计算缩略图本地哈希」，新结果会补上这一列。' }));
      slot.replaceChildren(...nodes);
    }

    function renderToolbar() {
      const bar = qs('#results-toolbar');
      if (!bar) return;
      const set = (key, value) => { state.filters[key] = value; state.offset = 0; void load(); };
      const q = h('input', { class: 'input', type: 'search', placeholder: '搜标题或域名', value: state.filters.q, style: { width: '200px' }, oninput: (ev) => { state.filters.q = ev.target.value; schedule(); } });
      const domain = h('input', { class: 'input', type: 'search', placeholder: '域名，如 example.com', value: state.filters.domain, style: { width: '190px' }, oninput: (ev) => { state.filters.domain = ev.target.value; schedule(); } });
      const provider = h('select', { class: 'select', style: { width: '140px' }, onchange: (ev) => set('provider', ev.target.value) },
        h('option', { value: '', text: '全部引擎' }), ...state.engines.map((e) => h('option', { value: e.id, text: engineLabel(e.id), selected: state.filters.provider === e.id })));
      const minScore = h('select', { class: 'select', style: { width: '132px' }, onchange: (ev) => set('min_score', ev.target.value) },
        h('option', { value: '', text: '排序分不限' }), [40, 60, 80].map((v) => h('option', { value: String(v), text: `≥ ${v}`, selected: state.filters.min_score === String(v) })));
      const sort = h('select', { class: 'select', style: { width: '150px' }, onchange: (ev) => set('sort', ev.target.value) },
        ...SORTS.map((s) => h('option', { value: s.v, text: `按${s.t}`, selected: state.filters.sort === s.v })));
      const order = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => set('order', state.filters.order === 'desc' ? 'asc' : 'desc') },
        icon('sort', 16), state.filters.order === 'desc' ? '降序' : '升序');
      bar.replaceChildren(
        h('div', { class: 'toolbar__group' }, icon('search', 16, 'muted'), q, domain),
        h('span', { class: 'toolbar__sep' }),
        h('div', { class: 'toolbar__group' }, provider, minScore, sort, order),
        h('span', { class: 'spacer' }),
        h('span', { class: 'muted', style: { fontSize: 'var(--text-sm)' }, text: `共 ${fmtInt(state.total)} 条` }));
    }

    function schedule() { clearTimeout(timer); timer = setTimeout(() => { state.offset = 0; void load(); }, 350); }

    function renderSummary() {
      const slot = qs('#summary-slot');
      if (!slot) return;
      const withHash = state.items.filter((r) => r.local_hash_similarity !== null && r.local_hash_similarity !== undefined).length;
      const strong = state.items.filter((r) => (r.sort_score ?? 0) >= 60).length;
      const stat = (k, v) => h('div', { class: 'stat' }, h('span', { class: 'stat__k', text: k }), h('span', { class: 'stat__v', text: String(v) }));
      slot.replaceChildren(h('div', { class: 'stat-grid' },
        stat('当前页结果', state.items.length),
        stat('排序分 ≥ 60', strong),
        stat('含本地哈希', withHash),
        stat('参与引擎', state.engines.filter((e) => e.enabled).length)));
    }

    function renderResults(err) {
      const body = qs('#results-body');
      if (!body) return;
      if (err) { body.replaceChildren(errorBlock(err, () => load())); return; }
      if (state.loading) { body.replaceChildren(resultsSkeleton(5)); return; }
      if (!state.items.length) {
        const filtered = Boolean(state.filters.q || state.filters.domain || state.filters.provider || state.filters.min_score || state.filters.task_id);
        body.replaceChildren(emptyBlock(filtered ? 'noFiltered' : 'noTask', filtered
          ? [h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => { state.filters = { q: '', domain: '', provider: '', min_score: '', sort: 'sort_score', order: 'desc', task_id: '' }; state.offset = 0; void load(); } }, icon('x', 16), '清空筛选条件')]
          : [h('a', { class: 'btn btn--primary', href: '/' }, icon('upload', 16), '去溯源工作台')]));
        return;
      }
      body.replaceChildren(h('div', { role: 'list', 'aria-label': '结果列表' }, ...state.items.map((r) => resultRow(r, { onSelect: openDetail }))));
    }

    function renderPager() {
      const pager = qs('#pager');
      if (!pager) return;
      const prev = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', disabled: state.offset <= 0, onclick: () => { state.offset = Math.max(0, state.offset - 30); void load(); } }, '上一页');
      const next = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', disabled: state.offset + 30 >= state.total, onclick: () => { state.offset += 30; void load(); } }, '下一页', icon('chevron-right', 16));
      pager.replaceChildren(h('span', { class: 'grow muted', style: { fontSize: 'var(--text-sm)' }, text: `第 ${state.offset + 1}–${Math.min(state.offset + 30, state.total)} 条，共 ${fmtInt(state.total)} 条` }), prev, next);
    }

    async function openDetail(result) {
      const ui = modal({
        title: '结果证据链',
        sub: result.domain || '',
        iconName: 'layers',
        wide: true,
        body: [loadingBlock('正在读取证据链', 4)],
        actions: [h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => ui.close() }, '关闭')],
      });
      try {
        const detail = await api.resultHits(result.id);
        ui.node.querySelector('.modal__body')?.replaceChildren(resultInspector({ result: detail, onCopyUrl: (u) => copyWithToast(u, '链接') }));
      } catch (err) {
        ui.node.querySelector('.modal__body')?.replaceChildren(errorBlock(err, () => openDetail(result)));
      }
    }
  },
};
