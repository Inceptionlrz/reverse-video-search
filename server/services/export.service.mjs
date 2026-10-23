// 导出服务：CSV（BOM + 公式注入防护）与 JSON（schema 版本 + 生成时间）。
// SPEC §14 验收项 4/5/6：
//   - 列名为数据字段语义（线索分 / 分数来源），不是界面标签（界面统一"排序分"）
//   - 分数不得使用概率 / 准确性措辞（含列名与表头）
//   - = + - @ 制表符 回车 开头的单元格按文本处理（前置单引号），判定发生在引号包裹之前
const CSV_COLUMNS = [
  ['id', '线索ID'],
  ['url', '来源页URL'],
  ['canonical_url', '规范化URL'],
  ['domain', '域名'],
  ['title', '标题'],
  ['provider', '引擎'],
  ['rank', '名次'],
  ['sort_score', '线索分'],
  ['score_basis', '分数来源'],
  ['local_hash_similarity', '本地哈希相似度'],
  ['thumb_url', '缩略图地址'],
  ['hit_count', '证据帧数'],
  ['discovered_ms', '发现时间'],
];

const INJECTION_LEAD = new Set(['=', '+', '-', '@', '\t', '\r']);

// 单个单元格：先判注入（包裹之前），再引号包裹与双引号转义。
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : String(value);
  if (INJECTION_LEAD.has(text.charAt(0))) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function csvRow(values) {
  return values.map(csvCell).join(',');
}

export function toCsv(results) {
  const lines = [csvRow(CSV_COLUMNS.map((c) => c[1]))];
  for (const item of results) {
    lines.push(
      csvRow(
        CSV_COLUMNS.map(([key]) => {
          if (key === 'discovered_ms') return item.discovered_ms ? new Date(item.discovered_ms).toISOString() : '';
          if (key === 'hit_count') return item.hit_count ?? 0;
          return item[key] ?? '';
        }),
      ),
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function toJson(results, { filters = {}, appVersion = '1.0.0' } = {}) {
  const items = results.map((item) => ({
    id: item.id,
    url: item.url,
    canonical_url: item.canonical_url,
    domain: item.domain,
    title: item.title,
    provider: item.provider,
    rank: item.rank,
    sort_score: item.sort_score,
    score_basis: item.score_basis,
    local_hash_similarity: item.local_hash_similarity,
    thumb_url: item.thumb_url,
    discovered_ms: item.discovered_ms ? new Date(item.discovered_ms).toISOString() : null,
    hits: (item.hits || []).map((h) => ({
      frame_id: h.frame_id,
      provider: h.provider,
      rank: h.rank,
      score_basis: h.score_basis,
      local_hash_similarity: h.local_hash_similarity,
    })),
  }));
  return `${JSON.stringify(
    {
      schema_version: 1,
      app_version: appVersion,
      generated_at: new Date().toISOString(),
      score_note: '线索分由引擎名次映射，本地哈希相似度由 dHash 实算；均非概率或准确性度量',
      filters,
      total: items.length,
      items,
    },
    null,
    2,
  )}\n`;
}

export function createExportService() {
  return { toCsv, toJson, csvCell, csvRow, columns: CSV_COLUMNS };
}
