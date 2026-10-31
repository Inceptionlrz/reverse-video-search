// inspector.view.js — 右栏：来源检查器（帧详情 / 结果证据链 / 手动检索入口）。
import { h, icon, safeHttpUrl } from '../dom.js';
import {
  fmtDuration, fmtDateTime, fmtLatency, fmtScore, fmtSim, engineLabel, errorText,
  analysisStatusText, ENGINE_AGG,
} from '../format.js';
import { degradationLog, scoreSourceTag, copyWithToast, manualCopyTargets } from './shared.view.js';
import { frameEngineMatrix } from './frames-col.view.js';

function kv(k, v, { mono = true } = {}) {
  return h('div', { class: 'kv__row' }, h('span', { class: 'kv__k', text: k }), h('span', { class: mono ? 'kv__v' : '', text: v ?? '—' }));
}

function thumb(src, label) {
  return h('div', { class: 'inspector__thumb' },
    src ? h('img', { src, alt: label }) : icon('image-off', 26));
}

/** 帧详情：本机信息 + 帧 × 引擎矩阵 + 每条分析的降级链路。 */
export function frameInspector({ frame, analyses, engines }) {
  const byProvider = new Map(analyses.map((a) => [a.provider, a]));
  return h('div', { class: 'stack' },
    thumb(frame.preview_url, `第 ${frame.seq} 帧预览`),
    h('div', {},
      h('p', { class: 'inspector__title', text: `第 ${frame.seq} 帧 · ${fmtDuration(frame.time_ms)}` }),
      h('p', { class: 'inspector__url', text: frame.file_name || '—' })),
    h('div', { class: 'kv' },
      kv('时间点', fmtDuration(frame.time_ms)),
      kv('尺寸', frame.width && frame.height ? `${frame.width} × ${frame.height}` : null),
      kv('本地 dHash', frame.dhash || '未计算'),
      kv('是否重复帧', frame.is_duplicate ? `是（分组 ${frame.dup_group ?? '—'}）` : '否'),
      kv('参与检索', frame.enabled ? '是' : '否（已停用）')),
    frameEngineMatrix(frame, analyses, engines),
    h('div', { class: 'stack', style: { gap: 'var(--space-2)' } },
      h('span', { class: 'section-title', text: '各引擎终态' }),
      ...engines.map((e) => {
        const a = byProvider.get(e.id);
        const st = a ? analysisStatusText(a.status) : { label: '未开始', tone: 'idle' };
        const manual = a && a.status === 'manual';
        return h('div', { class: 'panel panel--pad', style: { padding: 'var(--space-2) var(--space-3)' } },
          h('div', { class: 'row row--tight' }, h('span', { class: `dot dot--sm dot--${st.tone}` }), h('strong', { text: engineLabel(e.id) }),
            h('span', { class: 'chip', text: st.label }),
            h('span', { class: 'spacer' }),
            a?.latency_ms ? h('span', { class: 'muted mono', style: { fontSize: 'var(--text-xs)' }, text: fmtLatency(a.latency_ms) }) : null),
          a && a.status === 'manual' ? h('p', { class: 'field__hint', style: { marginTop: 'var(--space-1)' }, text: `${errorText(a.error_code)}：${a.error_message || '—'}` }) : null,
          a && a.status === 'failed' ? h('p', { class: 'field__hint', style: { marginTop: 'var(--space-1)' }, text: `${errorText(a.error_code)}：${a.error_message || '—'}` }) : null,
          manual ? manualActions(a) : null,
          a ? degradationLog(a) : null);
      })));
}

/** 手动检索入口：manual 态的平等出口（信息态，不是错误态）。 */
export function manualActions(analysis) {
  const url = safeHttpUrl(analysis.manual_url);
  // 图床的纯图片直链。用户反馈「点了复制却拿到本地路径」——
  // 手动入口必须能复制可贴进引擎"粘贴图片链接"框的公网 URL，
  // 而此前这个直链没落库，界面上只有本地磁盘路径可复制。
  const { link: imgUrl, path: localPath } = manualCopyTargets(analysis);
  const log = Array.isArray(analysis.degradation_log) ? analysis.degradation_log : [];
  // 带图深链 vs 普通上传页：前者点开即是结果页，后者还得自己传文件，文案必须区分。
  const deepLinked = log.some((r) => r.step === 'manual_deeplink' && r.ok);
  return h('div', { class: 'row row--wrap', style: { marginTop: 'var(--space-2)' } },
    url
      ? h('a', {
        class: 'btn btn--secondary btn--sm',
        href: url, target: '_blank', rel: 'noreferrer noopener',
        title: deepLinked ? '链接已带这张帧，浏览器打开即是结果页' : '需自行把帧传上去',
      }, icon('external-link', 14), deepLinked ? '在浏览器打开结果页' : '打开发引擎上传页')
      : null,
    imgUrl
      ? h('button', {
        class: 'btn btn--primary btn--sm', type: 'button',
        title: '公网图片直链，可贴进引擎的「粘贴图片链接」框',
        onclick: () => copyWithToast(imgUrl, '图片链接'),
      }, icon('copy', 14), '复制图片链接')
      : null,
    h('button', {
      class: 'btn btn--ghost btn--sm', type: 'button',
      title: '本机磁盘路径，仅在你能直接访问该机器时有用',
      onclick: () => copyWithToast(localPath, '本地帧路径'),
    }, icon('copy', 14), '复制本地路径'));
}

/** 结果详情：双轨分数 + 证据链（哪帧、哪个引擎、第几位）。 */
export function resultInspector({ result, onCopyUrl }) {
  const hits = result.hits || [];
  const frames = result.frames || [];
  return h('div', { class: 'stack' },
    thumb(safeHttpUrl(result.thumb_url), '结果缩略图'),
    h('div', {},
      h('p', { class: 'inspector__title', text: result.title || result.url }),
      h('p', { class: 'inspector__url', text: result.url }),
      h('div', { class: 'row row--wrap', style: { marginTop: 'var(--space-2)' } },
        safeHttpUrl(result.url) ? h('a', { class: 'btn btn--secondary btn--sm', href: safeHttpUrl(result.url), target: '_blank', rel: 'noreferrer noopener' }, icon('external-link', 14), '打开来源页') : null,
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => onCopyUrl(result.url) }, icon('copy', 14), '复制链接'))),
    h('div', { class: 'inspector-score' },
      h('div', { class: 'inspector-score__row' },
        h('span', { class: 'inspector-score__k', text: '排序分' }),
        h('span', { class: 'inspector-score__v', text: fmtScore(result.sort_score) ?? '—' })),
      h('div', { class: 'inspector-score__row' },
        h('span', { class: 'inspector-score__k', text: '本地哈希相似度' }),
        h('span', {}, h('span', { class: 'inspector-score__v', text: fmtSim(result.local_hash_similarity) ?? '—' }),
          h('span', { class: 'inspector-score__sub', text: result.local_hash_similarity === null || result.local_hash_similarity === undefined ? '未提供' : '本机实算' }))),
      h('div', { class: 'inspector-score__row' }, h('span', { class: 'inspector-score__k', text: '分数来源' }), scoreSourceTag(result.score_basis)),
      h('div', { class: 'inspector-score__row' }, h('span', { class: 'inspector-score__k', text: '引擎名次' }), h('span', { class: 'inspector-score__v', text: result.rank ? `第 ${result.rank} 位` : '—' })),
      h('div', { class: 'inspector-score__row' }, h('span', { class: 'inspector-score__k', text: '发现时间' }), h('span', { class: 'inspector-score__v', text: fmtDateTime(result.discovered_ms) }))),
    result.similarity_note ? h('p', { class: 'score-note', text: result.similarity_note }) : null,
    h('div', { class: 'stack', style: { gap: 'var(--space-2)' } },
      h('span', { class: 'section-title', text: `证据链（${hits.length} 条命中）` }),
      hits.length ? h('div', { class: 'host-list' }, ...hits.map((hit) => h('div', { class: 'consent-row' },
        icon('target', 14, 'muted'),
        h('span', { class: 'mono', text: engineLabel(hit.provider) }),
        h('span', { class: 'muted', text: hit.rank ? `第 ${hit.rank} 位` : '名次未记录' }),
        h('span', { class: 'spacer' }),
        h('span', { class: 'src-tag src-tag--engine', text: hit.score_basis === 'engine_rank' ? '引擎名次' : (hit.score_basis || '未提供') }))))
        : h('p', { class: 'muted', style: { fontSize: 'var(--text-sm)' }, text: '这条结果还没有命中记录。' })),
    frames.length ? h('div', { class: 'stack', style: { gap: 'var(--space-2)' } },
      h('span', { class: 'section-title', text: '相关帧' }),
      h('div', { class: 'frames' }, ...frames.slice(0, 12).map((f) => h('div', { class: 'frame', style: { cursor: 'default' } },
        h('img', { class: 'frame__img', src: f.preview_url, alt: `第 ${f.seq} 帧`, loading: 'lazy' }),
        h('span', { class: 'frame__time', text: fmtDuration(f.time_ms) }),
        h('span', { class: 'frame__foot' }, h('span', { class: 'mono', text: `#${f.seq}` }))))))
      : null);
}

/** 右栏空态：未选中任何对象。 */
export function inspectorEmpty() {
  return h('div', { class: 'empty' },
    icon('eye', 36, 'empty__icon'),
    h('p', { class: 'empty__title', text: '选中一帧或一条结果' }),
    h('p', { class: 'empty__desc', text: '左侧点帧看本机信息与降级链路，中间点结果看双轨分数与证据链。' }));
}

export const AGG = ENGINE_AGG;
