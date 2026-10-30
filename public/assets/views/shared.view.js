// shared.view.js — 跨视图复用的业务组件。业务语义红线（双轨分数、降级三族、外发确认）集中在此。
import { h, icon, skeletonRows, skeletonResults, modal, toast, copyText, safeHttpUrl } from '../dom.js';
import { api, errText } from '../api.js';
import {
  fmtScore, fmtSim, fmtAgo, fmtDateTime, fmtDuration, engineLabel, errorText, EMPTY_COPY,
  IMAGEHOST_OPTIONS, IMAGEHOST_LABEL,
} from '../format.js';

/** 状态点：颜色之外必须带图标或文案（无障碍双重编码）。 */
export function stateDot(tone, size = '') {
  return h('span', { class: `dot ${size} dot--${tone}`, 'aria-hidden': 'true' });
}

export function badge(text, tone = '', extra = '') {
  return h('span', { class: `badge${tone ? ` badge--${tone}` : ''} ${extra}`.trim(), text });
}

export function engineBadge(id) {
  return h('span', { class: 'chip', title: engineLabel(id) }, icon('target', 14), engineLabel(id));
}

/** 通用加载 / 空 / 错 / 离线 四态块。 */
export const loadingBlock = (title = '正在加载', lines = 6) =>
  h('div', { class: 'panel panel--pad', role: 'status', 'aria-live': 'polite' },
    h('div', { class: 'row', style: { marginBottom: 'var(--space-3)' } }, icon('loader', 18, 'btn__spin'), h('span', { class: 'fg2', text: title })),
    skeletonRows(lines));

export function emptyBlock(kind, actions = []) {
  const copy = EMPTY_COPY[kind] || EMPTY_COPY.noTask;
  return h('div', { class: 'empty', role: 'status' },
    icon(copy.icon, 40, 'empty__icon'),
    h('p', { class: 'empty__title', text: copy.title }),
    h('p', { class: 'empty__desc', text: copy.desc }),
    actions.length ? h('div', { class: 'empty__actions' }, actions) : null);
}

export function errorBlock(err, onRetry) {
  return h('div', { class: 'err-block', role: 'alert' },
    h('div', { class: 'err-block__title' }, icon('x-circle', 18), h('span', { text: errText(err, '加载失败') }),
      err && err.code ? h('span', { class: 'mono muted', style: { fontSize: 'var(--text-xs)', letterSpacing: '0.02em' }, text: String(err.code) }) : null),
    err && err.detail ? h('pre', { class: 'err-block__log', text: typeof err.detail === 'string' ? err.detail : JSON.stringify(err.detail, null, 2) }) : null,
    onRetry ? h('div', { class: 'row' }, h('button', { class: 'btn btn--secondary btn--sm', type: 'button', onclick: onRetry }, icon('refresh', 16), '重试')) : null);
}

export const offlineBlock = (onRetry) => errorBlock(new Error('连接不到本地服务（127.0.0.1:4173）。请确认已执行 npm start，服务进程仍在运行。'), onRetry);

/* ===== 双轨分数（SPEC §9：排序分 + 本地哈希相似度，两列并存） ===== */
function scoreTier(v) { return v >= 70 ? 'high' : v >= 40 ? 'mid' : 'low'; }

export function scoreCell({ sort_score: sortScore, local_hash_similarity: sim, note = '' } = {}) {
  const s = fmtScore(sortScore);
  const hv = fmtSim(sim);
  return h('div', { class: 'score-cell' },
    h('div', { class: 'score-row' },
      h('span', { class: 'score-row__label', text: '排序分' }),
      h('span', { class: 'microbar', 'aria-hidden': 'true' }, h('span', { class: 'microbar__fill', style: { width: `${s ?? 0}%` } })),
      s === null ? h('span', { class: 'score-row__val score-row__val--low', text: '—' }) : h('span', { class: `score-row__val score-row__val--${scoreTier(s)}`, text: String(s) })),
    h('div', { class: 'score-row score-row--hash' },
      h('span', { class: 'score-row__label', text: '本地哈希' }),
      h('span', { class: 'microbar', 'aria-hidden': 'true' }, h('span', { class: `microbar__fill microbar__fill--${scoreTier(hv ?? 0)}`, style: { width: `${hv ?? 0}%` } })),
      hv === null ? h('span', { class: 'score-row__val score-row__val--low', text: '—' }) : h('span', { class: `score-row__val score-row__val--${scoreTier(hv)}`, text: hv.toFixed(1) })),
    note ? h('span', { class: 'score-note', text: note }) : null);
}

/** 分数来源标注：无分数时给出「未提供」徽标，排序由后端沉底。 */
export function scoreSourceTag(basis) {
  if (basis === 'engine_rank') return h('span', { class: 'src-tag src-tag--engine', text: '来源：引擎名次' });
  if (basis === 'local_hash') return h('span', { class: 'src-tag src-tag--local', text: '来源：本地哈希' });
  return h('span', { class: 'src-tag src-tag--none', text: '未提供' });
}

/** 表头说明条：两列分数口径必须常驻可见。 */
export function scoreLegend() {
  return h('div', { class: 'consent-ack', role: 'note' },
    h('div', { class: 'row row--wrap', style: { gap: 'var(--space-3)' } },
      h('span', { class: 'row row--tight' }, icon('sort', 14), h('strong', { text: '排序分' }), h('span', { class: 'muted', text: '由引擎返回名次换算成 0–100，只决定排序先后，不衡量画面是否真的一致。' })),
      h('span', { class: 'row row--tight' }, icon('hash', 14), h('strong', { text: '本地哈希相似度' }), h('span', { class: 'muted', text: '本机对帧与结果图实算；未在设置中开启时显示「—」并标注「未提供」。' }))));
}

/* ===== 降级提示：信息态，不是错误态（UIUX §13） ===== */
export function banner({ tone = 'info', title, detail, actions = [], log = [], logLabel = '查看降级链路' }) {
  const logNode = log.length
    ? h('div', { class: 'banner__log' }, log.map((row) => h('div', { class: 'banner__log-row', text: `[${row.step ?? '—'}] ${row.ok ? '通过' : '未通过'}${row.code ? ` · ${row.code}` : ''}${row.message ? ` · ${row.message}` : ''}` })))
    : null;
  return h('div', { class: `banner${tone === 'warn' ? ' banner--warn' : tone === 'danger' ? ' banner--danger' : ''}`, role: tone === 'info' ? 'status' : 'alert' },
    icon(tone === 'info' ? 'info' : tone === 'warn' ? 'alert-triangle' : 'x-circle', 18, 'banner__icon'),
    h('div', { class: 'banner__body' },
      h('p', { class: 'banner__title', text: title }),
      detail ? h('p', { class: 'banner__detail', text: detail }) : null,
      logNode),
    actions.length ? h('div', { class: 'banner__actions' }, actions) : null);
}

/** 引擎级降级聚合：manual 是「待用户动作」琥珀态，不是失败。 */
export function degradedBanner(analyses, { onOpenManual } = {}) {
  const manual = analyses.filter((a) => a.status === 'manual');
  const failed = analyses.filter((a) => a.status === 'failed');
  if (manual.length) {
    const codes = [...new Set(manual.map((a) => a.error_code).filter(Boolean))];
    return banner({
      tone: 'warn',
      title: `${manual.length} 个帧 × 引擎组合已降级为手动检索`,
      detail: `发生了什么：${codes.map((c) => errorText(c)).join('、') || '自动链路不可用'}。已切到什么：帧不出本机，改为给你手动入口。你能做什么：点「手动检索入口」把帧贴到引擎上传页，或在引擎诊断页查看连通性。`,
      actions: onOpenManual ? [h('button', { class: 'btn btn--secondary btn--sm', type: 'button', onclick: onOpenManual }, icon('hand', 16), '手动检索入口')] : [],
    });
  }
  if (failed.length) {
    return banner({
      tone: 'danger',
      title: `${failed.length} 个帧 × 引擎组合失败`,
      detail: `发生了什么：${[...new Set(failed.map((a) => a.error_code))].map((c) => errorText(c)).join('、') || '执行异常'}。已切到什么：未写入任何结果。你能做什么：重试失败项，或去运行日志看 request_id 细节。`,
    });
  }
  return null;
}

/** 单个 analysis 的降级链路展开。 */
export function degradationLog(analysis) {
  const log = Array.isArray(analysis.degradation_log) ? analysis.degradation_log : [];
  if (!log.length) return null;
  return h('div', { class: 'stack', style: { gap: 'var(--space-1)' } },
    h('span', { class: 'field__label', text: '降级链路' }),
    ...log.map((row) => h('div', { class: 'consent-row' },
      icon(row.ok ? 'check-circle' : row.skipped ? 'chevron-right' : 'alert-triangle', 14, row.ok ? '' : 'muted'),
      h('span', { class: 'mono', text: String(row.step ?? '—') }),
      h('span', { class: 'muted', text: row.skipped ? `跳过：${row.reason || '—'}` : (row.message || errorText(row.code)) }))));
}

/* ===== 结果行 / 帧卡片 ===== */
export function resultRow(result, { selected = false, onSelect } = {}) {
  const url = safeHttpUrl(result.url);
  const thumb = safeHttpUrl(result.thumb_url);
  const providers = [...new Set((result.hits || []).map((x) => x.provider).filter(Boolean))];
  const note = result.similarity_note || (fmtSim(result.local_hash_similarity) === null ? '本地哈希未提供' : '');
  const node = h('div', { class: `result${selected ? ' result--selected' : ''}`, role: 'button', tabindex: '0', 'aria-label': `结果：${result.title || result.url}` },
    h('div', { class: 'result__thumb' }, thumb ? h('img', { src: thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : icon('image-off', 22)),
    h('div', { class: 'result__body' },
      h('div', { class: 'result__title clamp2', text: result.title || result.url }),
      h('div', { class: 'result__domain', text: result.domain || '—' }),
      h('div', { class: 'result__engines' }, providers.length ? providers.map(engineBadge) : h('span', { class: 'chip', text: '无引擎记录' })),
      h('div', { class: 'result__meta' },
        h('span', { text: `命中 ${result.hit_count ?? (result.hits || []).length} 次` }),
        h('span', { text: `发现于 ${fmtAgo(result.discovered_ms)}` }),
        result.url ? h('a', { href: url || '#', target: '_blank', rel: 'noreferrer noopener', class: 'row row--tight', onclick: (ev) => ev.stopPropagation() }, icon('external-link', 13), '打开来源') : null),
    scoreCell({ sort_score: result.sort_score, local_hash_similarity: result.local_hash_similarity, note })));
  const activate = () => onSelect && onSelect(result);
  node.addEventListener('click', activate);
  node.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); activate(); } });
  return node;
}

export const resultsSkeleton = (n = 5) => skeletonResults(n);

/* ===== 外发确认弹窗（UIUX §16：警示级，复选框默认不勾选，主按钮含具体查询次数） ===== */
const PRIVATE_HOST = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|localhost|0\.0\.0\.|::1$)/i;

/**
 * 公网 HTTP(S) 地址；内网 / 本机 / 非 http 一律判否。
 * 与服务端 analysis-execute.mjs 的 isPublicHttpUrl 同义——前端拿不到服务端模块，
 * 只能各写一份，改动其中一处时记得同步另一处。
 */
export function publicHttpUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (PRIVATE_HOST.test(u.hostname)) return null;
    return u.href;
  } catch {
    return null;
  }
}

/**
 * 各引擎在当前设置下真正会走通的自动路径（纯函数，无 DOM，可单测）。
 *
 * 判定顺序与执行层四级链路严格同序（upload → deeplink → bridge → manual），
 * 只报「当前设置下真正会走通的那一级」。曾有一版只要引擎 bridge 能力不是
 * unavailable 就一律标「可自动」，结果 Google Lens（bridge=unavailable）
 * 与 Bing 混在一起显示，用户发起 21 个作业后才发现 Lens 全程手动。
 *
 * @returns {Array<{id: string, path: 'upload'|'deeplink'|'bridge'|'bridge_no_site'|'manual', tone: string, label: string}>}
 */
export function engineReachability(engines, { imagehost = null, engineModes = {}, publicUrl = null } = {}) {
  const url = publicHttpUrl(publicUrl); // 内网地址对公网引擎不可达，深链必然跳过
  return (engines || [])
    .filter((e) => e && e.enabled)
    .map((e) => {
      const av = e.availability || {};
      const modes = engineModes[e.id] || {};
      const bridgeCapable = av.bridge !== 'unavailable';
      const bridgeOn = imagehost?.enabled === true;

      let path = 'manual';
      if (modes.upload && av.upload !== 'unavailable') path = 'upload';
      else if (modes.deeplink && av.deeplink !== 'unavailable' && url) path = 'deeplink';
      else if (bridgeCapable && bridgeOn) path = imagehost.provider ? 'bridge' : 'bridge_no_site';

      const LABEL = {
        upload: '可自动（直传）',
        deeplink: '可自动（深链）',
        bridge: '可自动（图床桥接）',
        bridge_no_site: '可自动（需在下方选站点）',
        // bridge 能力还在、只是图床总开关关着 → 明确给出「开了就能自动」，
        // 而不是干巴巴一句「需手动」，省得用户以为这条路天生走不通。
        manual: bridgeCapable && !bridgeOn ? '需手动（开启桥接后可自动）' : '需手动跑腿',
      };
      return { id: e.id, path, tone: path === 'manual' ? 'warn' : (path === 'bridge_no_site' ? 'idle' : 'ok'), label: LABEL[path] };
    });
}

/** 把可达性判定渲染成行：勾选前就能看见哪些引擎只能手动跑腿。 */
export function engineReachRows(engines, opts = {}) {
  const rows = engineReachability(engines, opts).map((r) =>
    h('div', { class: 'consent-row consent-row--sub' },
      icon(r.path === 'manual' ? 'hand' : 'send', 14, 'muted'),
      h('span', { class: 'fg2', text: engineLabel(r.id) }),
      badge(r.label, r.tone)));
  return rows.length
    ? h('div', { class: 'stack stack--tight' },
      h('span', { class: 'settings-row__desc', text: '勾选下方「允许图床桥接」并选择站点后，各引擎的自动可达性：' }),
      ...rows)
    : null;
}

export function consentModal({
  task, engines, imagehost, engineModes = {}, publicUrl = null, onConfirm,
}) {
  const frameCount = Math.max(1, Number(task?.frames_done) || 1);
  const engineIds = (engines || []).filter((e) => e.enabled).map((e) => e.id);
  const total = frameCount * Math.max(1, engineIds.length);
  let host = null;
  const checks = {
    engines: h('input', { type: 'checkbox', id: 'consent-engines' }),
    bridge: h('input', { type: 'checkbox', id: 'consent-bridge' }),
  };
  // 选项与设置页同一份 IMAGEHOST_OPTIONS，避免两边漂移。
  // 默认跟设置页的 provider 走：用户已在设置页选过站点时，不必每次弹窗重选。
  const hostSelect = h('select', { class: 'select', id: 'consent-host', disabled: true, style: { width: '180px' } },
    h('option', { value: '', text: '选择站点' }),
    ...IMAGEHOST_OPTIONS.map((o) => h('option', { value: o.id, text: o.label, selected: imagehost?.provider === o.id })));
  if (imagehost?.provider) host = imagehost.provider;
  checks.bridge.addEventListener('change', () => { hostSelect.disabled = !checks.bridge.checked; if (!checks.bridge.checked) host = null; });
  hostSelect.addEventListener('change', () => { host = hostSelect.value || null; });

  // 桥接行的可用性必须与设置一致：总开关关了 → 禁用并说明原因；
  // 开了但没选默认站点 → 允许在弹窗里现选（仅本次生效），并明说这一点。
  const bridgeOn = imagehost?.enabled === true;
  const bridgeHint = !imagehost
    ? '无法读取图床设置，桥接可能不可用。'
    : !bridgeOn
      ? '设置页已关闭图床桥接，勾选不会生效；需要先到设置页打开。'
      : imagehost.provider
        ? `默认站点：${IMAGEHOST_LABEL[imagehost.provider] || imagehost.provider}（可在此处改为其他站点，仅本次生效）。`
        : '设置页未选默认站点——在此处选择一个站点即可，仅对本任务生效。';
  if (!bridgeOn) {
    checks.bridge.disabled = true;
    hostSelect.disabled = true;
  }

  const submit = () => {
    if (!checks.engines.checked) { toast('必须勾选「允许发送到搜索引擎」才能继续', 'warn'); return; }
    if (checks.bridge.checked && !host) { toast('勾选图床桥接后必须选择一个站点', 'warn'); return; }
    onConfirm({ engines: true, bridge: checks.bridge.checked, imagehost: host });
    ui.close();
  };
  const ui = modal({
    title: '确认外发范围',
    sub: '帧图会离开本机，发送到公开搜索引擎。这一步每次任务都要单独确认。',
    iconName: 'shield-alert',
    dismissable: false,
    body: [
      h('div', { class: 'consent-block' },
        h('div', { class: 'consent-row' }, icon('send', 16), h('strong', { text: `将把 ${frameCount} 帧分别发送到 ${Math.max(1, engineIds.length)} 个引擎` })),
        h('p', { class: 'settings-row__desc', text: '检索以 HTTP 请求发出，请求头由本机直连或经本地代理转出。引擎侧可能记录你的 IP 与时间。' }),
        engineReachRows(engines, { imagehost, engineModes, publicUrl }),
        h('label', { class: 'checkbox' }, checks.engines,
          h('span', {}, h('span', { class: 'settings-row__label', text: '允许把帧发送到以下搜索引擎' }),
            h('span', { class: 'settings-row__desc', text: engineIds.length ? engineIds.map(engineLabel).join('、') : '当前没有已启用的引擎' }))),
        h('label', { class: 'checkbox' }, checks.bridge,
          h('span', {}, h('span', { class: 'settings-row__label', text: '允许图床桥接' }),
            h('span', { class: 'settings-row__desc', text: `先把帧临时上传到图床拿公网 URL，再送引擎。图床侧同样可能留存文件。${bridgeHint}` }))),
        h('div', { class: 'row' }, h('span', { class: 'field__label', text: '图床站点' }), hostSelect)),
      h('div', { class: 'consent-ack' }, icon('lock', 14), h('span', { text: '不勾选任何一项时，帧只会留在本机：你可以只抽帧、只算本地哈希，或使用下面的「仅本机抽帧，不外发」直接离开。' })),
    ],
    actions: [
      h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => ui.close() }, '仅本机抽帧，不外发'),
      h('button', { class: 'btn btn--primary', type: 'button', onclick: submit }, icon('send', 16), `确认并开始 ${total} 次检索`),
    ],
  });
  return ui;
}

/* ===== 导出弹窗：CSV / JSON，参数与列表筛选一致 ===== */
export function exportModal({ taskId, filters = {} }) {
  const fmt = { value: 'csv' };
  const radios = ['csv', 'json'].map((v) => h('label', { class: 'export-field__opt' },
    h('input', { type: 'radio', name: 'export-fmt', value: v, checked: v === 'csv', onchange: () => { fmt.value = v; } }), v.toUpperCase()));
  const ui = modal({
    title: '导出结果',
    sub: taskId ? '导出范围与当前任务的结果列表一致。' : '导出范围与当前筛选条件一致（不含分页上限）。',
    iconName: 'download',
    body: [
      h('div', { class: 'export-field' }, ...radios),
      h('p', { class: 'settings-row__desc', text: 'CSV 每行一条结果，含两列分数与来源标注；JSON 额外带命中证据链。文件由浏览器直接保存，不回传任何地址。' }),
    ],
    actions: [
      h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => ui.close() }, '取消'),
      h('button', { class: 'btn btn--primary', type: 'button', onclick: async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        btn.replaceChildren(icon('loader', 16, 'btn__spin'), '导出中');
        try {
          const params = { ...filters, ...(taskId ? { task_id: taskId } : {}) };
          const res = fmt.value === 'csv' ? await api.exportCsv(params) : await api.exportJson(params);
          const { downloadResponse } = await import('../dom.js');
          await downloadResponse(res, `rvs-results-${taskId || 'all'}.${fmt.value}`);
          ui.close();
          toast('导出已开始，文件由浏览器保存', 'ok');
        } catch (err) {
          toast(errText(err, '导出失败'), 'error');
          btn.disabled = false;
          btn.replaceChildren(icon('download', 16), '重新导出');
        }
      } }, icon('download', 16), '导出'),
    ],
  });
  return ui;
}

/** 复制到剪贴板 + 轻提示。 */
export async function copyWithToast(text, label = '内容') {
  const ok = await copyText(text);
  toast(ok ? `${label}已复制` : '浏览器拒绝了剪贴板访问', ok ? 'ok' : 'warn');
}

/** 轮询助手：返回 stop()；间隔由调用方按后端下发的 poll_interval_ms 动态决定。 */
export function createPoller(fn, getMs, { immediate = true } = {}) {
  let timer = 0;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try { await fn(); } catch { /* 由 fn 内部处理错误态 */ }
    if (stopped) return;
    timer = setTimeout(tick, Math.max(500, Number(getMs()) || 3000));
  };
  if (immediate) tick();
  else timer = setTimeout(tick, Math.max(500, Number(getMs()) || 3000));
  return () => { stopped = true; clearTimeout(timer); };
}

export const fmtTaskTime = (ms) => (Number.isFinite(ms) ? `${fmtDateTime(ms)}` : '—');
export const fmtTaskDuration = fmtDuration;
