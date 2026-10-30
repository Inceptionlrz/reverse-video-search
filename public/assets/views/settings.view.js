// settings.view.js — 设置：五个可写分区 + 只读运行环境镜像 + 主题切换。
// 状态覆盖：Loading / Empty / Error / Degraded / Populated / Edge / Offline。
import { h, icon, qs, toast } from '../dom.js';
import { api, errText } from '../api.js';
import { store, setTheme } from '../store.js';
import { extractModeText, engineLabel, IMAGEHOST_OPTIONS } from '../format.js';
import { loadingBlock, errorBlock, offlineBlock } from './shared.view.js';

export default {
  render(root, ctx) {
    void ctx;
    const state = { writable: null, readOnly: null, defaults: null, loading: true, error: null, dirty: false };

    root.append(
      h('div', { class: 'page-head' },
        h('div', { class: 'grow' },
          h('h1', { class: 'page-title', text: '设置' }),
          h('p', { class: 'page-sub', text: '可写项保存后立即生效；只读项来自启动环境变量，改动需重启服务。' }))),
      h('div', { id: 'degraded-slot', class: 'stack', style: { marginBottom: 'var(--space-3)' } }),
      h('form', { id: 'settings-form', class: 'settings-form' }, loadingBlock('正在读取设置', 6)),
      h('div', { class: 'settings-sticky', id: 'settings-actions' }));

    void load();
    return () => {};

    async function load() {
      try {
        const data = await api.settings();
        state.writable = structuredClone(data.writable || {});
        state.readOnly = data.read_only || null;
        state.defaults = data.defaults || null;
        state.loading = false; state.error = null;
        render();
      } catch (err) {
        state.loading = false; state.error = err;
        const form = qs('#settings-form');
        if (form) form.replaceChildren(err && err.httpStatus === 0 ? offlineBlock(load) : errorBlock(err, load));
      }
    }

    function render() {
      const form = qs('#settings-form');
      if (!form || !state.writable) return;
      const w = state.writable;
      form.replaceChildren(
        appearanceSection(),
        extractSection(w.extract),
        enginesSection(w.engines),
        imagehostSection(w.imagehost),
        similaritySection(w.similarity),
        exportSection(w.export),
        readOnlySection());
      renderActions();
      markDirty(false);
    }

    function markDirty(v) {
      state.dirty = v;
      const save = qs('#btn-save');
      if (save) save.disabled = !v;
    }

    function renderActions() {
      const slot = qs('#settings-actions');
      if (!slot) return;
      slot.replaceChildren(
        h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => { if (state.defaults) { state.writable = structuredClone(state.defaults); render(); toast('已恢复为默认值，记得保存', 'info'); } } }, icon('refresh', 16), '恢复默认'),
        h('button', { class: 'btn btn--primary', id: 'btn-save', type: 'button', disabled: true, onclick: save }, icon('check-circle', 16), '保存更改'));
    }

    async function save() {
      const btn = qs('#btn-save');
      if (!btn) return;
      btn.disabled = true;
      btn.replaceChildren(icon('loader', 16, 'btn__spin'), '保存中');
      try {
        await api.putSettings(state.writable);
        toast('设置已保存', 'ok');
        markDirty(false);
        btn.replaceChildren(icon('check-circle', 16), '保存更改');
      } catch (err) {
        toast(errText(err, '保存失败'), 'error');
        btn.disabled = false;
        btn.replaceChildren(icon('check-circle', 16), '重试保存');
      }
    }

    /* ===== 分区 ===== */
    function appearanceSection() {
      const theme = store.get().theme;
      return panel('外观', '主题切换只影响本机浏览器，写入 localStorage，不参与后端设置同步。',
        h('div', { class: 'settings-row' },
          h('div', { class: 'settings-row__text' },
            h('div', { class: 'settings-row__label', text: '界面主题' }),
            h('div', { class: 'settings-row__desc', text: '深色为默认工作寄存器；浅色为同套令牌的备用寄存器，长时间阅读时可切换。' })),
          h('div', { class: 'settings-row__ctl' },
            h('label', { class: 'chip' }, h('input', { type: 'radio', name: 'theme', checked: theme === 'dark', onchange: () => setTheme('dark') }), icon('moon', 14), '深色'),
            h('label', { class: 'chip' }, h('input', { type: 'radio', name: 'theme', checked: theme === 'light', onchange: () => setTheme('light') }), icon('sun', 14), '浅色'))));
    }

    function extractSection(ex) {
      if (!ex) return null;
      const mode = h('select', { class: 'select', onchange: (ev) => { ex.mode = ev.target.value; markDirty(true); } },
        h('option', { value: 'interval', text: '固定间隔', selected: ex.mode === 'interval' }),
        h('option', { value: 'scene', text: '场景切换', selected: ex.mode === 'scene' }),
        h('option', { value: 'both', text: '场景 + 间隔', selected: ex.mode === 'both' }));
      return panel('抽帧参数', `新任务默认按「${extractModeText(ex.mode)}」抽帧，上限 ${ex.max_frames} 帧。抽帧过程可在工作台逐任务覆盖。`,
        h('div', { class: 'settings-row' },
          h('div', { class: 'settings-row__text' }, h('div', { class: 'settings-row__label', text: '抽帧方式' }), h('div', { class: 'settings-row__desc', text: '场景切换依赖 ffmpeg 场景检测；检测不到切换点时会自动回退固定间隔。' })),
          h('div', { class: 'settings-row__ctl' }, h('div', { class: 'select-wrap' }, mode, icon('chevron-down', 14, 'select__caret')))),
        h('div', { class: 'settings-row' },
          h('div', { class: 'settings-row__text' }, h('div', { class: 'settings-row__label', text: '最多帧数（1–60）' }), h('div', { class: 'settings-row__desc', text: '帧数越多覆盖越全，检索请求次数也等比例增加。' })),
          h('div', { class: 'settings-row__ctl' }, numField(ex, 'max_frames', 1, 60))),
        h('div', { class: 'settings-row' },
          h('div', { class: 'settings-row__text' }, h('div', { class: 'settings-row__label', text: '固定间隔（毫秒，200–60000）' })),
          h('div', { class: 'settings-row__ctl' }, numField(ex, 'interval_ms', 200, 60000, 100))),
        h('div', { class: 'settings-row' },
          h('div', { class: 'settings-row__text' }, h('div', { class: 'settings-row__label', text: '场景阈值（0.05–0.9）' }), h('div', { class: 'settings-row__desc', text: '值越低检出的切换点越多。' })),
          h('div', { class: 'settings-row__ctl' }, numField(ex, 'scene_threshold', 0.05, 0.9, 0.05))));
    }

    function enginesSection(engines) {
      if (!engines) return null;
      return panel('引擎检索方式', '启停状态在引擎诊断页维护，这里只切两种检索方式。实测不可用的方式会被后端拒绝开启。',
        ...Object.entries(engines).map(([id, modes]) => h('div', { class: 'settings-row' },
          h('div', { class: 'settings-row__text' },
            h('div', { class: 'settings-row__label', text: engineLabel(id) }),
            h('div', { class: 'settings-row__desc', text: id === 'google_lens' ? '深链实测不可用：服务端会拒绝开启，作业直接走手动检索入口。' : '深链把图片 URL 交给引擎；直传为实验性 multipart 上传。' })),
          h('div', { class: 'settings-row__ctl' },
            h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: modes.deeplink, onchange: (ev) => { modes.deeplink = ev.target.checked; markDirty(true); } }), h('span', { class: 'switch__track' }), h('span', { class: 'switch__text', text: '深链' })),
            h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: modes.upload, onchange: (ev) => { modes.upload = ev.target.checked; markDirty(true); } }), h('span', { class: 'switch__track' }), h('span', { class: 'switch__text', text: '直传' }))))));
    }

    function imagehostSection(ih) {
      if (!ih) return null;
      // 站点说明随选择变化：每家的可用性差别很大（三家匿名图床实测均不可用），
      // 不写清就会有人勾了 tmpfiles 以为能用，跑完才发现全降级为手动。
      // 直接持有节点引用，不用 getElementById + setTimeout 那种时序脆弱的写法。
      const hintEl = h('div', { class: 'settings-row__desc' });
      const syncHostHint = () => {
        const picked = IMAGEHOST_OPTIONS.find((o) => o.id === ih.provider);
        hintEl.textContent = picked ? picked.hint : '未选择站点——桥接不可用，作业会降级为手动检索。';
      };
      syncHostHint();
      return panel('图床桥接', '开启总开关后，每个任务仍需在确认弹窗里单独勾选桥接并选择站点。',
        h('div', { class: 'settings-row' },
          h('div', { class: 'settings-row__text' }, h('div', { class: 'settings-row__label', text: '允许图床桥接' }), h('div', { class: 'settings-row__desc', text: '先把帧临时上传到图床换公网 URL，再走深链。帧会短暂离开本机。' })),
          h('div', { class: 'settings-row__ctl' }, h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: ih.enabled, onchange: (ev) => { ih.enabled = ev.target.checked; markDirty(true); } }), h('span', { class: 'switch__track' }), h('span', { class: 'switch__text', text: ih.enabled ? '已开启' : '已关闭' })))),
        h('div', { class: 'settings-row' },
          h('div', { class: 'settings-row__text' }, h('div', { class: 'settings-row__label', text: '默认站点' }), h('div', { class: 'settings-row__desc', text: '不选站点时桥接不可用，作业会降级为手动检索。' })),
          h('div', { class: 'settings-row__ctl' }, h('div', { class: 'select-wrap' },
            h('select', { class: 'select', onchange: (ev) => { ih.provider = ev.target.value || null; syncHostHint(); markDirty(true); } },
              h('option', { value: '', text: '未选择', selected: !ih.provider }),
              ...IMAGEHOST_OPTIONS.map((o) => h('option', { value: o.id, text: o.label, selected: ih.provider === o.id }))),
            icon('chevron-down', 14, 'select__caret')))),
        h('div', { class: 'settings-row' },
          h('div', { class: 'settings-row__text' }, h('div', { class: 'settings-row__label', text: '站点说明' }), hintEl)));
    }

    function similaritySection(sim) {
      if (!sim) return null;
      return panel('相似度计算', '控制是否额外下载结果缩略图，与本地帧实算 dHash 相似度。',
        h('div', { class: 'settings-row' },
          h('div', { class: 'settings-row__text' }, h('div', { class: 'settings-row__label', text: '计算缩略图本地哈希' }), h('div', { class: 'settings-row__desc', text: '开启后会为每个新结果临时下载缩略图（不落盘）算哈希，检索会变慢，且会向结果站点发出一次图片请求。关闭时本地哈希列显示「—」。' })),
          h('div', { class: 'settings-row__ctl' }, h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: sim.compute_thumb_hash, onchange: (ev) => { sim.compute_thumb_hash = ev.target.checked; markDirty(true); } }), h('span', { class: 'switch__track' }), h('span', { class: 'switch__text', text: sim.compute_thumb_hash ? '已开启' : '已关闭' })))));
    }

    function exportSection(ex) {
      if (!ex) return null;
      return panel('导出', 'CSV 与 JSON 的默认保存位置。留空则使用服务数据目录下的 exports。',
        h('div', { class: 'settings-row' },
          h('div', { class: 'settings-row__text' }, h('div', { class: 'settings-row__label', text: '导出目录' }), h('div', { class: 'settings-row__desc', text: '浏览器下载仍由你自己选择保存位置；这里记录的是服务端导出文件的落点。' })),
          h('div', { class: 'settings-row__ctl' }, h('input', { class: 'input', type: 'text', value: ex.dir || '', placeholder: 'data/exports', style: { width: '260px' }, oninput: (ev) => { ex.dir = ev.target.value.trim() || null; markDirty(true); } }))));
    }

    function readOnlySection() {
      const ro = state.readOnly;
      if (!ro) return null;
      const row = (k, v) => h('div', { class: 'kv__row' }, h('span', { class: 'kv__k', text: k }), h('span', { class: 'kv__v', text: v ?? '—' }));
      return h('details', { class: 'panel' },
        h('summary', { class: 'panel__head', style: { cursor: 'pointer' } }, icon('server', 16), h('span', { class: 'panel__title grow', text: '只读运行环境（来自启动环境变量）' }), icon('chevron-down', 14, 'muted')),
        h('div', { class: 'panel__body stack' },
          h('div', { class: 'kv' }, row('监听地址', `${ro.server?.host}:${ro.server?.port}`), row('出站方式', ro.network?.proxy ? `代理 ${ro.network.proxy}` : ro.network?.proxy_note), row('最小请求间隔', `${ro.network?.min_interval_ms} ms`), row('抽帧并发', ro.network?.parallelism?.extract), row('分析并发', ro.network?.parallelism?.analysis), row('单引擎并发', ro.network?.parallelism?.per_engine)),
          h('div', { class: 'kv' }, row('ffmpeg', ro.media?.ffmpeg), row('ffprobe', ro.media?.ffprobe), row('日志级别', ro.logging?.level), row('日志目录', ro.logging?.dir)),
          h('div', { class: 'kv' }, row('遥测', ro.telemetry?.enabled ? '开启' : '关闭'), row('遥测端点', ro.telemetry?.endpoint || '未配置'))));
    }

    function numField(target, key, min, max, step = 1) {
      return h('input', { class: 'input', type: 'number', min: String(min), max: String(max), step: String(step), value: String(target[key] ?? ''), style: { width: '120px' }, oninput: (ev) => {
        const n = Number(ev.target.value);
        if (Number.isFinite(n)) { target[key] = Math.min(max, Math.max(min, n)); markDirty(true); }
      } });
    }
  },
};

function panel(title, note, ...rows) {
  return h('section', { class: 'panel' },
    h('div', { class: 'panel__head' }, h('h2', { class: 'panel__title', text: title })),
    h('div', { class: 'panel__body' },
      note ? h('p', { class: 'section-note', text: note }) : null,
      ...rows.filter(Boolean)));
}
