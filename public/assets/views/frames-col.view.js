// frames-col.view.js — 左栏：帧网格（FrameGrid）。
// 每帧显示聚合态（idle/running/ok/zero/throttled/failed/disabled），状态用「圆点 + 文案」双重编码。
import { h, icon } from '../dom.js';
import { fmtDuration, ENGINE_AGG, ENGINE_LABEL } from '../format.js';

/** 由该帧的所有 analysis 推导引擎聚合态（优先级：进行中 > 待手动 > 失败 > 命中 > 无命中 > 未开始）。 */
export function frameAggregate(analyses) {
  if (!analyses.length) return 'idle';
  if (analyses.some((a) => ['queued', 'running'].includes(a.status))) return 'running';
  if (analyses.some((a) => a.status === 'manual')) return 'throttled';
  if (analyses.some((a) => a.status === 'failed')) return 'failed';
  if (analyses.every((a) => a.status === 'cancelled')) return 'idle';
  if (analyses.some((a) => a.status === 'succeeded')) return 'ok';
  if (analyses.every((a) => a.status === 'zero_result')) return 'zero';
  return 'idle';
}

export function frameTile(frame, { analyses = [], selected = false, focused = false, onSelect }) {
  const agg = frameAggregate(analyses);
  const meta = ENGINE_AGG[agg] || ENGINE_AGG.idle;
  const running = agg === 'running';
  const cls = ['frame'];
  if (selected) cls.push('frame--selected');
  if (!frame.enabled) cls.push('frame--disabled');
  if (agg === 'failed') cls.push('frame--failed');
  const badge = !frame.enabled
    ? h('span', { class: 'frame__badge', title: '该帧已停用，不参与检索' }, icon('ban', 12))
    : agg === 'throttled' ? h('span', { class: 'frame__badge frame__badge--warn', title: '待手动检索' }, icon('hand', 12))
    : agg === 'failed' ? h('span', { class: 'frame__badge frame__badge--danger', title: '检索失败' }, icon('x-circle', 12))
    : null;
  const node = h('button', { class: cls.join(' '), type: 'button', 'aria-pressed': String(selected), 'aria-label': `第 ${frame.seq} 帧，${fmtDuration(frame.time_ms)}，${meta.label}` },
    h('img', { class: 'frame__img', src: frame.preview_url, alt: `第 ${frame.seq} 帧，位于 ${fmtDuration(frame.time_ms)}`, loading: 'lazy' }),
    h('span', { class: 'frame__time', text: fmtDuration(frame.time_ms) }),
    badge,
    h('span', { class: 'frame__foot' },
      h('span', { class: 'mono', text: `#${frame.seq}` }),
      h('span', { class: 'row row--tight' }, h('span', { class: `dot dot--sm dot--${meta.tone}` }), h('span', { class: 'truncate', text: meta.label }))),
    running ? h('span', { class: 'frame__bar', 'aria-hidden': 'true' }) : null);
  node.addEventListener('click', () => onSelect(frame));
  if (focused) requestAnimationFrame(() => node.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  return node;
}

export function frameGrid(frames, { selectedId, focusId, analysesByFrame = new Map(), onSelect }) {
  if (!frames.length) return null;
  return h('div', { class: 'frames', role: 'listbox', 'aria-label': '帧列表' },
    ...frames.map((f) => frameTile(f, {
      analyses: analysesByFrame.get(f.id) || [],
      selected: f.id === selectedId,
      focused: f.id === focusId,
      onSelect,
    })));
}

/** 帧 × 引擎矩阵：一帧在各引擎上的终态。 */
export function frameEngineMatrix(frame, analyses, engines) {
  if (!engines.length) return null;
  const byProvider = new Map(analyses.map((a) => [a.provider, a]));
  const head = h('div', { class: 'matrix__cell matrix__cell--frame', text: `#${frame.seq}` });
  const cells = engines.map((e) => {
    const a = byProvider.get(e.id);
    const st = a ? (a.status === 'succeeded' ? 'ok' : a.status === 'zero_result' ? 'zero' : a.status === 'manual' ? 'throttled' : a.status === 'failed' ? 'failed' : a.status === 'cancelled' ? 'idle' : 'running') : 'idle';
    const meta = ENGINE_AGG[st] || ENGINE_AGG.idle;
    return h('div', { class: 'matrix__cell', title: `${ENGINE_LABEL[e.id] || e.id}：${meta.label}` },
      h('span', { class: `dot dot--sm dot--${meta.tone}` }), h('span', { class: 'truncate', text: meta.label }));
  });
  return h('div', { class: 'matrix', style: { gridTemplateColumns: `56px repeat(${engines.length}, minmax(72px, 1fr))` }, role: 'table', 'aria-label': `第 ${frame.seq} 帧在各引擎上的状态` }, head, ...cells);
}
