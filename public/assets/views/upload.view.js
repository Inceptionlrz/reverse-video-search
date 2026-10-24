// upload.view.js — 溯源工作台：DropZone + QueueSummary + TaskQueueTable。
// 状态覆盖：Loading / Empty / Error / Degraded / Populated / Edge / Offline。
import { h, icon, toast, qs } from '../dom.js';
import { api, errText } from '../api.js';
import { bus, EVT } from '../store.js';
import { fmtDuration, fmtAgo, fmtInt, taskStatusText, extractModeText } from '../format.js';
import { emptyBlock, errorBlock, loadingBlock, banner, createPoller, stateDot } from './shared.view.js';

const WARN_COPY = {
  duration_too_long: '视频时长超过抽帧上限，只会覆盖前面一段时间',
  low_resolution: '源分辨率低于 240px，检索命中率通常很低',
  codec_unusual: '编码不在常见列表，ffmpeg 可能抽帧失败',
  remote_url_not_public: '目标地址不是公网地址，引擎侧无法直接抓取',
};

export default {
  render(root, ctx) {
    let lastItems = [];
    root.append(
      h('div', { class: 'page-head' },
        h('div', { class: 'grow' },
          h('h1', { class: 'page-title', text: '溯源工作台' }),
          h('p', { class: 'page-sub', text: '把视频拆成关键帧，逐帧送进公开反向图片引擎，汇总可能的原始出处。帧不出本机，除非你逐次确认。' }))),
      h('div', { id: 'degraded-slot' }),
      buildDropPanel(),
      h('div', { id: 'summary-slot', style: { margin: 'var(--space-4) 0' } }),
      h('div', { class: 'panel', id: 'queue-panel' },
        h('div', { class: 'panel__head' },
          h('h2', { class: 'panel__title grow', text: '任务队列' }),
          h('span', { class: 'muted', id: 'queue-count', style: { fontSize: 'var(--text-sm)' } })),
        h('div', { id: 'queue-body' }, loadingBlock('正在读取任务队列', 5))));

    const stopPoll = createPoller(load, () => (hasActive() ? 3000 : 10000));
    const offTask = bus.on(EVT.taskChanged, () => { void load(); });
    void load();
    return () => { stopPoll(); offTask(); };

    function hasActive() {
      return (lastItems || []).some((t) => ['extracting', 'analyzing'].includes(t.status));
    }

    function buildDropPanel() {
      const mode = h('select', { class: 'select', id: 'ex-mode' },
        h('option', { value: 'interval', text: '固定间隔' }), h('option', { value: 'scene', text: '场景切换' }), h('option', { value: 'both', text: '场景 + 间隔' }));
      const maxFrames = h('input', { class: 'input', id: 'ex-max', type: 'number', min: '1', max: '60', value: '12', style: { width: '88px' } });
      const interval = h('input', { class: 'input', id: 'ex-interval', type: 'number', min: '200', max: '60000', step: '100', value: '1500', style: { width: '96px' } });
      const threshold = h('input', { class: 'input', id: 'ex-threshold', type: 'number', min: '0.05', max: '0.9', step: '0.05', value: '0.25', style: { width: '88px' } });
      const fileInput = h('input', { class: 'dropzone__input', type: 'file', id: 'file-input', accept: 'video/*,.mp4,.mov,.mkv,.webm,.avi,.flv,.ts' });
      const pathInput = h('input', { class: 'input', id: 'src-path', type: 'text', placeholder: 'D:\\videos\\clip.mp4', spellcheck: 'false' });
      const urlInput = h('input', { class: 'input', id: 'src-url', type: 'url', placeholder: 'https://example.com/video.mp4', spellcheck: 'false' });

      const extractOpts = () => ({
        extract_mode: mode.value,
        max_frames: Number(maxFrames.value) || undefined,
        frame_interval_ms: Number(interval.value) || undefined,
        scene_threshold: Number(threshold.value) || undefined,
      });

      const zone = h('div', { class: 'dropzone', id: 'dropzone', tabindex: '0', role: 'button', 'aria-label': '拖入视频文件或点击选择文件' },
        icon('upload', 40, 'dropzone__icon'),
        h('p', { class: 'dropzone__main', text: '把视频拖到这里' }),
        h('p', { class: 'dropzone__sub', text: '或点击选择本地文件 · 支持 mp4 / mov / mkv / webm 等 ffmpeg 可读格式' }),
        fileInput);

      zone.addEventListener('click', (ev) => { if (ev.target !== fileInput) fileInput.click(); });
      zone.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); fileInput.click(); } });
      ['dragenter', 'dragover'].forEach((t) => zone.addEventListener(t, (ev) => { ev.preventDefault(); zone.classList.add('dropzone--active'); }));
      ['dragleave', 'drop'].forEach((t) => zone.addEventListener(t, (ev) => { ev.preventDefault(); zone.classList.remove('dropzone--active'); }));
      zone.addEventListener('drop', (ev) => { const f = ev.dataTransfer?.files?.[0]; if (f) void submitFile(f); });
      fileInput.addEventListener('change', () => { const f = fileInput.files?.[0]; if (f) void submitFile(f); fileInput.value = ''; });

      async function submitFile(file) {
        const btn = qs('#submit-file');
        setBusy(btn, true, '上传中');
        try {
          const data = await api.uploadTaskFile(file, extractOpts());
          showPlan(data.plan);
          toast(`已创建任务：${data.task.display_name || file.name}`, 'ok');
          ctx.navigate(`/tasks/${data.task.id}`);
        } catch (err) {
          toast(errText(err, '创建任务失败'), 'error');
          setBusy(btn, false, '选择视频文件');
        }
      }

      return h('div', { class: 'panel panel--pad' },
        zone,
        buildSourceRow({ pathInput, urlInput, extractOpts }),
        buildExtractRow({ mode, maxFrames, interval, threshold }),
        h('div', { id: 'precheck-slot' }));
    }

    /** 来源行：本地路径 / 公网视频地址 + 创建任务按钮。 */
    function buildSourceRow({ pathInput, urlInput, extractOpts }) {
      return h('div', { class: 'row row--wrap', style: { marginTop: 'var(--space-3)', gap: 'var(--space-3)' } },
        h('div', { class: 'field grow', style: { minWidth: '220px' } }, h('label', { class: 'field__label', for: 'src-path', text: '本地路径' }), pathInput),
        h('div', { class: 'field grow', style: { minWidth: '220px' } }, h('label', { class: 'field__label', for: 'src-url', text: '公网视频地址' }), urlInput),
        h('button', { class: 'btn btn--secondary', id: 'submit-file', type: 'button', onclick: async (ev) => {
          const p = pathInput.value.trim();
          const u = urlInput.value.trim();
          if (!p && !u) { toast('先填本地路径或公网地址', 'warn'); return; }
          setBusy(ev.currentTarget, true, '创建中');
          try {
            const data = await api.createTask({ ...(p ? { source_type: 'file', source_path: p } : { source_type: 'url', source_url: u }), display_name: p ? p.split(/[\\/]/).pop() : u, ...extractOpts() });
            showPlan(data.plan);
            toast('任务已创建', 'ok');
            ctx.navigate(`/tasks/${data.task.id}`);
          } catch (err) { toast(errText(err, '创建任务失败'), 'error'); setBusy(ev.currentTarget, false, '创建任务'); }
        } }, icon('plus', 16), '创建任务'));
    }

    /** 抽帧参数行：方式 / 最多帧数 / 间隔 / 场景阈值。 */
    function buildExtractRow({ mode, maxFrames, interval, threshold }) {
      return h('div', { class: 'row row--wrap', style: { marginTop: 'var(--space-3)', gap: 'var(--space-3)' } },
        h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'ex-mode', text: '抽帧方式' }), h('div', { class: 'select-wrap' }, mode, icon('chevron-down', 14, 'select__caret'))),
        h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'ex-max', text: '最多帧数（≤60）' }), maxFrames),
        h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'ex-interval', text: '间隔（毫秒）' }), interval),
        h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'ex-threshold', text: '场景阈值' }), threshold));
    }

    function setBusy(btn, busy, label) {
      if (!btn) return;
      btn.disabled = busy;
      btn.replaceChildren(busy ? icon('loader', 16, 'btn__spin') : icon('upload', 16), label);
    }

    function showPlan(plan) {
      const slot = qs('#precheck-slot');
      if (!slot || !plan) return;
      const warns = Array.isArray(plan.warnings) ? plan.warnings : [];
      slot.replaceChildren(warns.length
        ? h('div', { class: 'precheck' }, warns.map((w) => h('div', { class: 'precheck__row' }, icon('alert-triangle', 14), h('span', { text: WARN_COPY[w] || w }))))
        : h('div', { class: 'precheck' }, h('div', { class: 'precheck__row' }, icon('check-circle', 14), h('span', { text: `预检通过：预计抽出约 ${plan.estimated_frames} 帧（${extractModeText(plan.strategy?.replace('_plan', ''))}）` }))));
    }

    function renderDegraded(health) {
      const slot = qs('#degraded-slot');
      if (!slot) return;
      const nodes = [];
      if (!health) return;
      if (health.offline) nodes.push(banner({ tone: 'warn', title: '当前离线模式（RVS_OFFLINE=1）', detail: '发生了什么：服务以离线模式启动。已切到什么：不会发起任何外网请求，帧只留在本机。你能做什么：照常抽帧与算本地哈希，外发需重启服务并关闭离线开关。' }));
      if (!health.ffmpeg?.available) nodes.push(banner({ tone: 'danger', title: 'ffmpeg 不可用，无法抽帧', detail: `发生了什么：找不到可用的 ffmpeg 可执行文件。已切到什么：任务会停在预检失败。你能做什么：安装 ffmpeg 并加入 PATH，然后回到本页重试。错误：${health.ffmpeg?.error || '未记录'}` }));
      slot.replaceChildren(...nodes);
    }

    async function load() {
      const body = qs('#queue-body');
      if (!body) return;
      try {
        const [tasks, health] = await Promise.all([api.listTasks({ limit: 50 }), api.health().catch(() => null)]);
        lastItems = tasks.items || [];
        renderDegraded(health);
        renderSummary(tasks.total ?? lastItems.length, lastItems);
        renderQueue(lastItems);
      } catch (err) {
        body.replaceChildren(errorBlock(err, load));
      }
    }

    function renderSummary(total, items) {
      const slot = qs('#summary-slot');
      if (!slot) return;
      const count = (s) => items.filter((t) => (Array.isArray(s) ? s.includes(t.status) : t.status === s)).length;
      const stat = (k, v, ic) => h('div', { class: 'stat' }, h('span', { class: 'stat__k', text: k }), h('span', { class: 'stat__v' }, icon(ic, 13), String(v)));
      slot.replaceChildren(h('div', { class: 'stat-grid' },
        stat('任务总数', fmtInt(total), 'layers'),
        stat('抽帧中', count(['extracting']), 'loader'),
        stat('分析中', count(['analyzing']), 'search'),
        stat('已完成', count(['done', 'frames_ready']), 'check-circle'),
        stat('失败', count('failed'), 'x-circle')));
    }

    function renderQueue(items) {
      const body = qs('#queue-body');
      const count = qs('#queue-count');
      if (!body) return;
      if (count) count.textContent = `共 ${items.length} 条`;
      if (!items.length) {
        body.replaceChildren(emptyBlock('noTask', [h('button', { class: 'btn btn--primary', type: 'button', onclick: () => qs('#file-input')?.click() }, icon('upload', 16), '选择视频文件')]));
        return;
      }
      const head = h('div', { class: 'tr tr--head cols-tasks' },
        h('span', { text: '任务' }), h('span', { text: '状态' }), h('span', { text: '帧' }), h('span', { text: '分析' }), h('span', { text: '时长' }), h('span', { text: '更新' }), h('span', { text: '操作' }));
      body.replaceChildren(head, ...items.map((t) => taskRow(t)));
    }

    function taskRow(t) {
      const st = taskStatusText(t.status);
      const del = h('button', { class: 'icon-btn icon-btn--danger', type: 'button', 'aria-label': `删除任务 ${t.display_name || t.id}`, title: '删除任务', onclick: async (ev) => {
        ev.stopPropagation();
        if (!window.confirm(`删除任务「${t.display_name || t.id}」？帧文件与分析记录会一并清除。`)) return;
        try { await api.deleteTask(t.id); toast('任务已删除', 'ok'); void load(); }
        catch (err) { toast(errText(err, '删除失败'), 'error'); }
      } }, icon('trash', 16));
      const row = h('div', { class: 'tr cols-tasks', role: 'button', tabindex: '0', 'aria-label': `打开任务 ${t.display_name || t.id}` },
        h('span', { class: 'row row--tight', style: { minWidth: '0' } }, icon(t.source_type === 'url' ? 'globe' : 'file-video', 16, 'muted'),
          h('span', { class: 'truncate', text: t.display_name || t.source_name || t.id })),
        h('span', { class: 'row row--tight' }, stateDot(st.tone, 'dot--sm'), h('span', { class: 'nowrap', text: st.label })),
        h('span', { class: 'mono num', text: `${t.frames_done ?? 0}/${t.max_frames ?? '—'}` }),
        h('span', { class: 'mono num', text: `${t.analyses_done ?? 0}/${t.analyses_total ?? 0}` }),
        h('span', { class: 'mono num muted', text: fmtDuration(t.duration_ms) }),
        h('span', { class: 'muted nowrap', style: { fontSize: 'var(--text-sm)' }, text: fmtAgo(t.updated_ms || t.created_ms) }),
        h('span', { class: 'tr__actions' }, del));
      row.addEventListener('click', () => ctx.navigate(`/tasks/${t.id}`));
      row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') ctx.navigate(`/tasks/${t.id}`); });
      return row;
    }
  },
};
