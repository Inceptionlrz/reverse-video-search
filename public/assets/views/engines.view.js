// engines.view.js — 引擎诊断：三引擎卡片、连通性自测、配额与熔断、重试策略说明、图床桥接。
// 状态覆盖：Loading / Empty / Error / Degraded / Populated / Edge / Offline。
import { h, icon, qs, toast } from '../dom.js';
import { api, errText } from '../api.js';
import { fmtAgo, fmtLatency, engineLabel, AVAILABILITY_TEXT, IMAGEHOST_LABEL, errorText } from '../format.js';
import { loadingBlock, errorBlock, banner, createPoller } from './shared.view.js';

export default {
  render(root, ctx) {
    void ctx;
    const state = { engines: [], imagehost: null, loading: true, error: null, health: null };

    root.append(
      h('div', { class: 'page-head' },
        h('div', { class: 'grow' },
          h('h1', { class: 'page-title', text: '引擎诊断' }),
          h('p', { class: 'page-sub', text: '三个公开反向图片引擎的启停、实测可用性与熔断状态。启停只影响后续检索，不影响已入库的结果。' }))),
      h('div', { id: 'degraded-slot', class: 'stack', style: { marginBottom: 'var(--space-3)' } }),
      h('div', { id: 'engines-body' }, loadingBlock('正在读取引擎状态', 5)),
      h('div', { id: 'policy-body' }),
      h('div', { id: 'imagehost-body', style: { marginTop: 'var(--space-4)' } }));

    void load();
    const stop = createPoller(() => load({ silent: true }), () => 15000);
    return stop;

    async function load({ silent = false } = {}) {
      if (!silent) { state.loading = true; renderEngines(); }
      try {
        const [data, health] = await Promise.all([api.engines(), api.health().catch(() => null)]);
        state.engines = data.engines || [];
        state.imagehost = data.imagehost || null;
        state.health = health;
        state.loading = false; state.error = null;
        renderDegraded();
        renderEngines();
        renderPolicy();
        renderImagehost();
      } catch (err) {
        state.loading = false; state.error = err;
        if (!silent) renderEngines(err);
      }
    }

    function renderDegraded() {
      const slot = qs('#degraded-slot');
      if (!slot) return;
      const nodes = [];
      if (state.health?.offline) nodes.push(banner({ tone: 'warn', title: '当前离线模式', detail: '发生了什么：服务以离线模式启动。已切到什么：连通性自测会直接失败，不会发出请求。你能做什么：重启服务关闭离线开关后再测。' }));
      const open = state.engines.filter((e) => e.circuit_open);
      if (open.length) nodes.push(banner({ tone: 'info', title: `${open.length} 个引擎正在熔断`, detail: `发生了什么：连续失败达到阈值。已切到什么：这些引擎的作业会被调度层直接降级为手动检索，不发请求。你能做什么：等熔断倒计时结束，或先排除网络问题再试。剩余时间：${open.map((e) => `${engineLabel(e.id)} ${e.circuit_remaining_sec}s`).join('、')}` }));
      const allDisabled = state.engines.length && state.engines.every((e) => !e.enabled);
      if (allDisabled) nodes.push(banner({ tone: 'danger', title: '三个引擎全部停用', detail: '发生了什么：没有引擎参与检索。已切到什么：发起检索会直接失败。你能做什么：至少启用一个引擎。' }));
      slot.replaceChildren(...nodes);
    }

    function renderEngines(err) {
      const body = qs('#engines-body');
      if (!body) return;
      if (err) { body.replaceChildren(errorBlock(err, () => load())); return; }
      if (state.loading) { body.replaceChildren(loadingBlock('正在读取引擎状态', 5)); return; }
      if (!state.engines.length) { body.replaceChildren(banner({ tone: 'info', title: '没有注册任何引擎', detail: '后端引擎注册表为空，这是异常状态，请查看运行日志。' })); return; }
      body.replaceChildren(h('div', { class: 'grid-3' }, ...state.engines.map(engineCard)));
    }

    function engineCard(e) {
      const tone = !e.enabled ? 'disabled' : e.circuit_open ? 'throttled' : 'ok';
      const modes = e.modes || { deeplink: false, upload: false };
      const avail = (key) => {
        const a = AVAILABILITY_TEXT[e.availability?.[key]] || AVAILABILITY_TEXT.unverified;
        return h('span', { class: `chip`, title: e.notes || '' }, h('span', { class: `dot dot--sm dot--${a.tone}` }), a.label);
      };
      const probeBtn = h('button', { class: 'btn btn--secondary btn--sm', type: 'button', onclick: (ev) => probe(e, ev.currentTarget) }, icon('zap', 14), '连通性自测');
      const enabledSwitch = h('label', { class: 'switch' },
        h('input', { type: 'checkbox', checked: e.enabled, onchange: (ev) => patchEngine(e.id, { enabled: ev.target.checked }) }),
        h('span', { class: 'switch__track' }), h('span', { class: 'switch__text', text: e.enabled ? '已启用' : '已停用' }));
      return h('div', { class: `panel engine-card${!e.enabled ? '' : e.circuit_open ? ' engine-card--degraded' : ''}` },
        h('div', { class: 'engine-card__head' }, h('span', { class: `dot dot--${tone}` }), h('strong', { class: 'grow', text: engineLabel(e.id) }), enabledSwitch),
        h('div', { class: 'engine-card__body' },
          h('div', { class: 'row row--wrap' }, avail('deeplink'), avail('upload'), avail('bridge')),
          h('p', { class: 'settings-row__desc', text: e.notes || '暂无实测备注' }),
          h('div', { class: 'kv' },
            kv('入口地址', e.entry_url),
            kv('连续失败', String(e.consecutive_failures ?? 0)),
            kv('熔断状态', e.circuit_open ? `熔断中，剩余 ${e.circuit_remaining_sec} 秒` : '未熔断'),
            kv('最近成功', e.last_success_ms ? fmtAgo(e.last_success_ms) : '从未成功'),
            kv('最近失败', e.last_failure_ms ? `${fmtAgo(e.last_failure_ms)}（${errorText(e.last_error_code)}）` : '从未失败')),
          h('div', { class: 'stack', style: { gap: 'var(--space-1)' } },
            h('span', { class: 'field__label', text: '检索方式' }),
            modeSwitch(e, 'deeplink', '深链（把图片 URL 交给引擎）', modes.deeplink),
            modeSwitch(e, 'upload', '直传（multipart 上传，实验性）', modes.upload)),
          h('div', { id: `probe-${e.id}`, class: 'stack', style: { gap: 'var(--space-1)' } })),
        h('div', { class: 'engine-card__foot' },
          probeBtn,
          e.entry_url ? h('a', { class: 'btn btn--ghost btn--sm', href: e.entry_url, target: '_blank', rel: 'noreferrer noopener' }, icon('external-link', 14), '打开引擎') : null));
    }

    function modeSwitch(e, key, label, on) {
      const blocked = e.availability?.[key] === 'unavailable';
      return h('label', { class: 'switch', title: blocked ? '实测不可用，不能开启' : '' },
        h('input', { type: 'checkbox', checked: on, disabled: blocked, onchange: (ev) => patchEngine(e.id, { [key]: ev.target.checked }) }),
        h('span', { class: 'switch__track' }), h('span', { class: 'switch__text', text: blocked ? `${label}（实测不可用）` : label }));
    }

    async function patchEngine(id, body) {
      try {
        await api.patchEngine(id, body);
        toast('引擎设置已更新', 'ok');
        await load({ silent: true });
      } catch (err) { toast(errText(err, '更新失败'), 'error'); await load({ silent: true }); }
    }

    async function probe(e, btn) {
      const slot = qs(`#probe-${e.id}`);
      btn.disabled = true;
      btn.replaceChildren(icon('loader', 14, 'btn__spin'), '自测中');
      if (slot) slot.replaceChildren(h('span', { class: 'muted', style: { fontSize: 'var(--text-sm)' }, text: '正在请求引擎入口…' }));
      try {
        const r = await api.probeEngine(e.id);
        if (slot) slot.replaceChildren(h('div', { class: 'consent-row' },
          icon(r.reachable ? 'check-circle' : 'x-circle', 14),
          h('span', { text: r.reachable ? '入口可达' : '入口不可达' }),
          h('span', { class: 'spacer' }),
          h('span', { class: 'mono muted', text: `${fmtLatency(r.latency_ms)}${r.http_status ? ` · HTTP ${r.http_status}` : ''}` })),
          r.error_message ? h('p', { class: 'field__hint', text: r.error_message }) : null);
      } catch (err) {
        if (slot) slot.replaceChildren(h('p', { class: 'field__hint', text: errText(err, '自测失败') }));
      } finally {
        btn.disabled = false;
        btn.replaceChildren(icon('zap', 14), '重新自测');
      }
    }

    /* 配额与重试策略：静态说明，数值与 server/lib/config.mjs、engine-health.service.mjs 对齐。 */
    function renderPolicy() {
      const slot = qs('#policy-body');
      if (!slot) return;
      const row = (k, v) => h('div', { class: 'kv__row' }, h('span', { class: 'kv__k', text: k }), h('span', { class: 'kv__v', text: v }));
      slot.replaceChildren(h('div', { class: 'panel', style: { marginTop: 'var(--space-4)' } },
        h('div', { class: 'panel__head' }, icon('shield-alert', 16), h('h2', { class: 'panel__title grow', text: '配额与重试策略' })),
        h('div', { class: 'panel__body' },
          h('p', { class: 'section-note', text: '三个引擎都没有申请官方 API 配额，全部走公开页面与公开端点，因此没有每日次数保证。能跑多少取决于对方风控，本节说明本机这一侧的自我约束。' }),
          h('div', { class: 'kv' },
            row('请求间隔', '同一引擎两次请求至少间隔 1.2 秒，实际带 ±20% 随机抖动，避免形成固定节奏'),
            row('并发上限', '全局同时 2 个检索作业，单个引擎同时只跑 1 个'),
            row('熔断规则', '同一引擎连续 3 次触发限流或被拒（RATE_LIMITED / FORBIDDEN）→ 熔断 10 分钟'),
            row('熔断期间', '该引擎的新作业不再发请求，直接降级为手动检索，你可以在任务详情里手动完成'),
            row('不计入熔断', '零结果（引擎可达但没找到相似图）不算失败，不会推高熔断计数'),
            row('自动降级链', '深链 → 直传 → 图床桥接 → 手动检索，逐级尝试，每一级都记进 degradation_log'),
            row('失败重试', '不自动重试原作业，避免把对方风控推得更紧；用任务详情的「重试失败项」手动重排')))));
    }

    function renderImagehost() {
      const slot = qs('#imagehost-body');
      const ih = state.imagehost;
      if (!slot || !ih) return;
      const hosts = ih.hosts || [];
      const hostSwitch = h('label', { class: 'switch' },
        h('input', { type: 'checkbox', checked: Boolean(ih.enabled), onchange: (ev) => patchImagehost({ enabled: ev.target.checked }) }),
        h('span', { class: 'switch__track' }), h('span', { class: 'switch__text', text: ih.enabled ? '已开启' : '已关闭' }));
      slot.replaceChildren(h('div', { class: 'panel' },
        h('div', { class: 'panel__head' }, icon('cloud-off', 16), h('h2', { class: 'panel__title grow', text: '图床桥接' }), hostSwitch),
        h('div', { class: 'panel__body' },
          h('p', { class: 'section-note', text: '当本地帧没有公网 URL 时，先把帧临时上传到图床换取公网地址，再走深链。开启总开关后仍需在每个任务的确认弹窗里单独授权。' }),
          h('div', { class: 'host-list' }, ...hosts.map((host) => h('label', { class: 'settings-row', style: { borderTop: '0', padding: 'var(--space-2) 0' } },
            h('span', { class: 'settings-row__text' },
              h('span', { class: 'settings-row__label', text: IMAGEHOST_LABEL[host.id] || host.id }),
              h('span', { class: 'settings-row__desc', text: `保留策略：${host.retention || '未说明'}${host.verified ? '' : ' · 未验证'}` })),
            h('span', { class: 'settings-row__ctl' },
              h('input', { type: 'radio', name: 'imagehost', checked: ih.provider === host.id, disabled: !ih.enabled, onchange: () => patchImagehost({ provider: host.id }) })))))
        )));
    }

    async function patchImagehost(patch) {
      try {
        const cur = state.imagehost || {};
        await api.putSettings({ imagehost: { enabled: cur.enabled, provider: cur.provider, ...patch } });
        toast('图床设置已更新', 'ok');
        await load({ silent: true });
      } catch (err) { toast(errText(err, '更新失败'), 'error'); }
    }
  },
};

function kv(k, v) {
  return h('div', { class: 'kv__row' }, h('span', { class: 'kv__k', text: k }), h('span', { class: 'kv__v', text: v ?? '—' }));
}
