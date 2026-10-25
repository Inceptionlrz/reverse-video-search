// task-detail.view.js — 任务详情三栏：FrameGrid + ResultToolbar + DegradedBanner + ResultList + SourceInspector。
// 深链 /tasks/:id/frames/:frameId 直达并高亮该帧。七态全覆盖。
import { h, icon, qs } from '../dom.js';
import { api } from '../api.js';
import { bus, EVT } from '../store.js';
import {
  fmtDuration, fmtDateTime, fmtInt, engineLabel, taskStatusText, extractModeText,
} from '../format.js';
import {
  loadingBlock, errorBlock, emptyBlock, offlineBlock, banner, degradedBanner, resultRow, resultsSkeleton,
  exportModal, scoreLegend, createPoller, stateDot, copyWithToast,
} from './shared.view.js';
import { frameGrid } from './frames-col.view.js';
import { frameInspector, resultInspector, inspectorEmpty } from './inspector.view.js';
import { doExtract, controlTask, runAnalysesFlow } from './task-actions.view.js';
import { openManualRunbook } from './manual-runbook.view.js';

const SORTS = [
  { v: 'sort_score', t: '排序分' },
  { v: 'local_hash_similarity', t: '本地哈希相似度' },
  { v: 'hits', t: '命中次数' },
  { v: 'discovered', t: '发现时间' },
];

export default {
  render(root, ctx) {
    const id = ctx.params.id;
    const state = {
      task: null, frames: [], analyses: [], results: [], total: 0, engines: [],
      selFrame: ctx.params.frameId || null, selResult: null,
      filters: { q: '', provider: '', min_score: '', sort: 'sort_score', order: 'desc' },
      loading: true, error: null, resultsLoading: true,
    };
    let searchTimer = 0;

    const runFlow = () => runAnalysesFlow({
      taskId: id,
      task: state.task,
      engines: state.engines,
      enabledFrames: state.frames.filter((f) => f.enabled).length,
      onDone: loadAll,
    });

    root.append(
      h('div', { class: 'page-head' },
        h('div', { class: 'grow' },
          h('h1', { class: 'page-title', id: 'task-title', text: '任务详情' }),
          h('p', { class: 'page-sub', id: 'task-sub' })),
        h('div', { class: 'row row--wrap', id: 'task-actions' })),
      h('div', { id: 'degraded-slot', class: 'stack', style: { marginBottom: 'var(--space-3)' } }),
      h('div', { class: 'split', id: 'split' },
        h('div', { class: 'split__col split__col--frames' },
          h('div', { class: 'split__head' }, icon('frame', 16), h('strong', { class: 'grow', text: '帧' }), h('span', { class: 'muted', id: 'frame-count', style: { fontSize: 'var(--text-sm)' } })),
          h('div', { class: 'split__body', id: 'frames-body' }, loadingBlock('正在读取帧', 6))),
        h('div', { class: 'split__col' },
          h('div', { class: 'toolbar', id: 'result-toolbar' }),
          h('div', { id: 'center-slot', class: 'stack', style: { padding: 'var(--space-3)' } },
            h('div', { id: 'results-body' }, resultsSkeleton(4)))),
        h('div', { class: 'split__col split__col--inspector' },
          h('div', { class: 'split__head' }, icon('eye', 16), h('strong', { text: '来源检查器' })),
          h('div', { class: 'split__body', id: 'inspector-body' }, inspectorEmpty()))));

    const stop = createPoller(loadTask, () => state.task?.poll_interval_ms || 3000);
    const offTask = bus.on(EVT.taskChanged, (tid) => { if (tid === id) void loadAll(); });
    void loadAll();
    return () => { stop(); offTask(); };

    /* ===== 数据 ===== */
    async function loadTask() {
      try {
        state.task = await api.getTask(id);
        renderHead();
        renderActions();
        renderDegraded();
        if (['extracting', 'analyzing'].includes(state.task.status)) void loadAll();
      } catch (err) {
        if (state.task) console.warn('[task-detail] 轮询失败', errText(err));
        else renderFatal(err);
      }
    }

    async function loadAll() {
      try {
        const [task, frames, analyses, engines] = await Promise.all([
          api.getTask(id), api.listFrames(id), api.listAnalyses(id), api.engines().catch(() => ({ engines: [] })),
        ]);
        state.task = task; state.frames = frames.items || []; state.analyses = analyses.items || [];
        state.engines = engines.engines || [];
        state.loading = false; state.error = null;
        if (state.selFrame && !state.frames.some((f) => f.id === state.selFrame)) state.selFrame = null;
        if (!state.selFrame && state.frames.length) state.selFrame = state.frames[0].id;
        renderHead(); renderActions(); renderDegraded(); renderFrames(); renderToolbar();
        await loadResults();
      } catch (err) {
        state.loading = false;
        renderFatal(err);
      }
    }

    async function loadResults() {
      state.resultsLoading = true;
      renderResults();
      try {
        const data = await api.listResults({ task_id: id, limit: 50, ...state.filters });
        state.results = data.items || []; state.total = data.total ?? state.results.length;
        state.resultsLoading = false;
        renderResults();
      } catch (err) {
        state.resultsLoading = false;
        renderResults(err);
      }
    }

    /* ===== 渲染 ===== */
    function renderFatal(err) {
      const title = qs('#task-title');
      if (title) title.textContent = '任务加载失败';
      qs('#degraded-slot')?.replaceChildren(err && err.httpStatus === 404
        ? emptyBlock('noTask', [h('a', { class: 'btn btn--primary', href: '/' }, icon('upload', 16), '回到工作台')])
        : offlineBlock(loadAll));
      void err;
    }

    function renderHead() {
      const t = state.task;
      const title = qs('#task-title');
      const sub = qs('#task-sub');
      if (!t || !title) return;
      title.textContent = t.display_name || t.source_name || t.id;
      const st = taskStatusText(t.status);
      sub.replaceChildren(
        h('span', { class: 'row row--tight' }, stateDot(st.tone, 'dot--sm'), h('span', { text: st.label })),
        h('span', { text: `· ${t.source_type === 'url' ? '公网地址' : '本地文件'}` }),
        h('span', { class: 'truncate', text: t.source_url || t.source_path || '', style: { maxWidth: '40ch' } }),
        h('span', { text: `· ${extractModeText(t.extract_mode)} · 上限 ${t.max_frames} 帧` }),
        t.duration_ms ? h('span', { text: `· 时长 ${fmtDuration(t.duration_ms)}` }) : null,
        t.width && t.height ? h('span', { class: 'muted', text: `· ${t.width}×${t.height}` }) : null,
        h('span', { class: 'muted', text: `· 创建于 ${fmtDateTime(t.created_ms)}` }));
    }

    function renderActions() {
      const host = qs('#task-actions');
      const t = state.task;
      if (!host || !t) return;
      const btns = [];
      if (['created', 'ready', 'failed', 'cancelled'].includes(t.status)) {
        btns.push(h('button', { class: 'btn btn--primary', type: 'button', onclick: (ev) => doExtract(id, ev.currentTarget, loadTask) }, icon('film', 16), t.status === 'failed' ? '重新抽帧' : '开始抽帧'));
      }
      if (['frames_ready', 'done', 'paused'].includes(t.status)) {
        btns.push(h('button', { class: 'btn btn--primary', type: 'button', onclick: runFlow }, icon('search', 16), state.analyses.length ? '再跑一次检索' : '发起检索'));
      }
      if (t.status === 'analyzing') btns.push(h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => controlTask(id, 'pause', loadAll) }, icon('pause', 16), '暂停'));
      if (t.status === 'paused') btns.push(h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => controlTask(id, 'resume', loadAll) }, icon('play', 16), '继续'));
      if (['analyzing', 'paused', 'extracting'].includes(t.status)) btns.push(h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => controlTask(id, 'cancel', loadAll) }, icon('stop', 16), '取消'));
      if (state.analyses.some((a) => ['failed', 'manual', 'cancelled'].includes(a.status))) {
        btns.push(h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => controlTask(id, 'retry-failed', loadAll) }, icon('refresh', 16), '重试失败项'));
      }
      btns.push(h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => exportModal({ taskId: id, filters: state.filters }) }, icon('download', 16), '导出'));
      host.replaceChildren(...btns);
    }

    function renderDegraded() {
      const slot = qs('#degraded-slot');
      const t = state.task;
      if (!slot || !t) return;
      const nodes = [];
      if (t.status === 'failed' && t.ffmpeg_error) {
        nodes.push(banner({ tone: 'danger', title: '抽帧失败', detail: `发生了什么：ffmpeg 无法从该源抽帧。已切到什么：任务停在失败态，没有帧可用。你能做什么：换源或改抽帧参数后重试。错误：${String(t.ffmpeg_error).slice(-400)}` }));
      }
      if (t.status === 'extracting') {
        nodes.push(banner({ tone: 'info', title: '正在抽帧', detail: '已切到什么：帧写入本机 data/frames 目录，期间可以离开本页，队列会继续跑。' }));
      }
      if (t.status === 'analyzing') {
        nodes.push(banner({ tone: 'info', title: `正在检索：${t.analyses_done}/${t.analyses_total}`, detail: '已切到什么：检索按引擎并发排队执行，完成一项记一项。你能做什么：暂停后改帧启停，或取消后重试失败项。' }));
      }
      if (t.status === 'paused') nodes.push(banner({ tone: 'warn', title: '队列已暂停', detail: '发生了什么：你手动暂停了分析队列。已切到什么：排队项停在原处，运行项跑完即止。你能做什么：点「继续」恢复。' }));
      if (t.status === 'cancelled') nodes.push(banner({ tone: 'warn', title: '任务已取消', detail: '发生了什么：你取消了分析。已切到什么：未完成项标记为已取消，已完成的结果仍保留。你能做什么：重试失败项会把这些项重新入队。' }));
      if (!t.confirmed && state.frames.length) {
        nodes.push(banner({ tone: 'warn', title: '尚未确认外发范围', detail: '发生了什么：这个任务还没有授权任何帧离开本机。已切到什么：只能抽帧与查看本机信息。你能做什么：点「发起检索」，在弹窗里勾选引擎范围。' }));
      }
      const agg = degradedBanner(state.analyses, { onOpenManual: () => openManualRunbook({ analyses: state.analyses, frames: state.frames }) });
      if (agg) nodes.push(agg);
      slot.replaceChildren(...nodes);
    }

    function renderFrames() {
      const body = qs('#frames-body');
      const count = qs('#frame-count');
      if (!body) return;
      if (count) count.textContent = `${state.frames.length} 帧`;
      if (!state.frames.length) {
        body.replaceChildren(emptyBlock('noFrame', state.task?.status === 'extracting' ? [] : [h('button', { class: 'btn btn--primary', type: 'button', onclick: (ev) => doExtract(id, ev.currentTarget, loadAll) }, icon('film', 16), '开始抽帧')]));
        return;
      }
      const byFrame = new Map();
      for (const a of state.analyses) {
        if (!byFrame.has(a.frame_id)) byFrame.set(a.frame_id, []);
        byFrame.get(a.frame_id).push(a);
      }
      const grid = frameGrid(state.frames, { selectedId: state.selFrame, analysesByFrame: byFrame, onSelect: selectFrame });
      body.replaceChildren(grid, h('div', { class: 'hr' }), frameStats());
      renderInspector();
    }

    function frameStats() {
      const t = state.task;
      const dup = state.frames.filter((f) => f.is_duplicate).length;
      const off = state.frames.filter((f) => !f.enabled).length;
      return h('div', { class: 'stat-grid' },
        h('div', { class: 'stat' }, h('span', { class: 'stat__k', text: '已启用' }), h('span', { class: 'stat__v', text: `${state.frames.length - off}/${state.frames.length}` })),
        h('div', { class: 'stat' }, h('span', { class: 'stat__k', text: '重复帧' }), h('span', { class: 'stat__v', text: String(dup) })),
        h('div', { class: 'stat' }, h('span', { class: 'stat__k', text: '帧上限' }), h('span', { class: 'stat__v', text: String(t?.max_frames ?? '—') })));
    }

    function renderToolbar() {
      const bar = qs('#result-toolbar');
      if (!bar) return;
      const q = h('input', { class: 'input', type: 'search', placeholder: '搜标题或域名', value: state.filters.q, style: { width: '180px' }, oninput: (ev) => { state.filters.q = ev.target.value; scheduleSearch(); } });
      const provider = h('select', { class: 'select', style: { width: '140px' }, onchange: (ev) => { state.filters.provider = ev.target.value; void loadResults(); } },
        h('option', { value: '', text: '全部引擎' }), ...state.engines.map((e) => h('option', { value: e.id, text: engineLabel(e.id), selected: state.filters.provider === e.id })));
      const minScore = h('select', { class: 'select', style: { width: '128px' }, onchange: (ev) => { state.filters.min_score = ev.target.value; void loadResults(); } },
        h('option', { value: '', text: '排序分不限' }), [40, 60, 80].map((v) => h('option', { value: String(v), text: `≥ ${v}`, selected: state.filters.min_score === String(v) })));
      const sort = h('select', { class: 'select', style: { width: '148px' }, onchange: (ev) => { state.filters.sort = ev.target.value; void loadResults(); } },
        ...SORTS.map((s) => h('option', { value: s.v, text: `按${s.t}`, selected: state.filters.sort === s.v })));
      const order = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', title: '切换升序 / 降序', onclick: () => { state.filters.order = state.filters.order === 'desc' ? 'asc' : 'desc'; void loadResults(); } },
        icon('sort', 16), state.filters.order === 'desc' ? '降序' : '升序');
      bar.replaceChildren(
        h('div', { class: 'toolbar__group' }, icon('search', 16, 'muted'), q),
        h('span', { class: 'toolbar__sep' }),
        h('div', { class: 'toolbar__group' }, provider, minScore, sort, order),
        h('span', { class: 'spacer' }),
        h('span', { class: 'muted', style: { fontSize: 'var(--text-sm)' }, id: 'result-count', text: `${fmtInt(state.total)} 条` }));
      const legend = qs('#score-legend') || h('div', { id: 'score-legend', style: { padding: 'var(--space-3) var(--space-3) 0' } });
      legend.replaceChildren(scoreLegend());
      if (!legend.parentElement) qs('#center-slot')?.prepend(legend);
    }

    function scheduleSearch() {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => void loadResults(), 350);
    }

    function renderResults(err) {
      const body = qs('#results-body');
      const count = qs('#result-count');
      if (!body) return;
      if (count) count.textContent = `${fmtInt(state.total)} 条`;
      if (err) { body.replaceChildren(errorBlock(err, loadResults)); return; }
      if (state.resultsLoading) { body.replaceChildren(resultsSkeleton(4)); return; }
      if (!state.results.length) {
        const filtered = Boolean(state.filters.q || state.filters.provider || state.filters.min_score);
        const kind = filtered ? 'noFiltered' : (state.analyses.length ? 'noHit' : (state.frames.length ? 'noAnalysis' : 'noFrame'));
        body.replaceChildren(emptyBlock(kind, filtered
          ? [h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => { state.filters = { q: '', provider: '', min_score: '', sort: 'sort_score', order: 'desc' }; renderToolbar(); void loadResults(); } }, icon('x', 16), '清空筛选条件')]
          : state.analyses.length ? [] : [h('button', { class: 'btn btn--primary', type: 'button', onclick: runFlow }, icon('search', 16), '发起检索')]));
        return;
      }
      body.replaceChildren(h('div', { role: 'list', 'aria-label': '结果列表' }, ...state.results.map((r) => resultRow(r, { selected: r.id === state.selResult, onSelect: selectResult }))));
    }

    /* ===== 交互 ===== */
    function selectFrame(frame) {
      state.selFrame = frame.id;
      state.selResult = null;
      ctx.replace(`/tasks/${id}/frames/${frame.id}`);
      renderFrames();
    }

    async function selectResult(result) {
      state.selResult = result.id;
      renderResults();
      const body = qs('#inspector-body');
      if (body) body.replaceChildren(loadingBlock('正在读取证据链', 4));
      try {
        const detail = await api.resultHits(result.id);
        if (state.selResult !== result.id) return;
        qs('#inspector-body')?.replaceChildren(resultInspector({ result: detail, onCopyUrl: (u) => copyWithToast(u, '链接') }));
      } catch (err) {
        qs('#inspector-body')?.replaceChildren(errorBlock(err, () => selectResult(result)));
      }
    }

    function renderInspector() {
      const body = qs('#inspector-body');
      if (!body) return;
      const frame = state.frames.find((f) => f.id === state.selFrame);
      if (!frame) { body.replaceChildren(inspectorEmpty()); return; }
      const analyses = state.analyses.filter((a) => a.frame_id === frame.id);
      body.replaceChildren(frameInspector({ frame, analyses, engines: state.engines }));
    }
  },
};
