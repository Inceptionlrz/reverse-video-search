// format.js — 中文文案字典与数值格式化。业务措辞红线集中落在本文件：
//   1. UI 统一称「排序分」，界面任何位置不出现「线索分」；
//   2. 分数不得使用概率 / 准确性措辞（匹配度、置信度、准确率、命中概率等一律禁用）；
//   3. 降级提示三要素：发生了什么 + 已切到什么 + 你能做什么。
export const BANNED_SCORE_WORDS = ['线索分', '匹配度', '置信度', '准确率', '命中概率', '可能性', '概率为', '可信度'];

const pad2 = (n) => String(n).padStart(2, '0');

/** 毫秒时长 → m:ss / h:mm:ss。 */
export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const hh = Math.floor(total / 3600);
  return hh ? `${hh}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

/** 时间戳 → MM-DD HH:mm */
export function fmtDateTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const d = new Date(ms);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 时间戳 → HH:mm:ss（日志用） */
export function fmtClock(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 相对时间：刚刚 / N 秒前 / N 分钟前 / N 小时前 / N 天前 */
export function fmtAgo(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const diff = Date.now() - ms;
  if (diff < 45000) return '刚刚';
  if (diff < 3600000) return `${Math.round(diff / 1000)} 秒前`;
  if (diff < 86400000) return `${Math.round(diff / 60000)} 分钟前`;
  if (diff < 2592000000) return `${Math.round(diff / 86400000)} 天前`;
  return fmtDateTime(ms);
}

export function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export const fmtInt = (n) => (Number.isFinite(n) ? n.toLocaleString('zh-CN') : '—');

/** 运行时长 → 3 天 4 小时 / 4 小时 12 分 / 12 分 30 秒 */
export function fmtUptime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const hh = Math.floor((s % 86400) / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (d) return `${d} 天 ${hh} 小时`;
  if (hh) return `${hh} 小时 ${mm} 分`;
  if (mm) return `${mm} 分 ${ss} 秒`;
  return `${ss} 秒`;
}

/** 排序分 / 相似度统一取整；缺失返回 null（由调用方渲染「—」与「未提供」）。 */
export const fmtScore = (v) => (Number.isFinite(v) ? Math.round(v) : null);

/** 本地哈希相似度保留一位小数。 */
export const fmtSim = (v) => (Number.isFinite(v) ? v.toFixed(1) : null);

export const fmtMs = (v) => (Number.isFinite(v) ? `${fmtInt(Math.round(v))} ms` : '—');

export const fmtLatency = (v) => (Number.isFinite(v) ? (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`) : '—');

/* ===== 字典：任务状态 ===== */
export const TASK_STATUS = {
  created: { label: '已创建', tone: 'idle', icon: 'clock' },
  ready: { label: '待抽帧', tone: 'idle', icon: 'film' },
  extracting: { label: '抽帧中', tone: 'running', icon: 'loader' },
  frames_ready: { label: '帧已就绪', tone: 'ok', icon: 'check-circle' },
  analyzing: { label: '分析中', tone: 'running', icon: 'loader' },
  paused: { label: '已暂停', tone: 'throttled', icon: 'pause' },
  done: { label: '已完成', tone: 'ok', icon: 'check-circle' },
  cancelled: { label: '已取消', tone: 'idle', icon: 'ban' },
  failed: { label: '失败', tone: 'failed', icon: 'x-circle' },
};

export const taskStatusText = (s) => (TASK_STATUS[s] || { label: s || '未知', tone: 'idle', icon: 'info' });

/* ===== 字典：帧 × 引擎分析态（七态 + 聚合） ===== */
export const ANALYSIS_STATUS = {
  queued: { label: '排队中', tone: 'idle' },
  running: { label: '检索中', tone: 'running' },
  succeeded: { label: '已命中', tone: 'ok' },
  zero_result: { label: '无命中', tone: 'zero' },
  manual: { label: '待手动', tone: 'throttled' },
  failed: { label: '失败', tone: 'failed' },
  cancelled: { label: '已取消', tone: 'idle' },
};

export const analysisStatusText = (s) => (ANALYSIS_STATUS[s] || { label: s || '未知', tone: 'idle' });

/** 引擎在某帧上的聚合态（由多条分析推导，UI 侧计算）。 */
export const ENGINE_AGG = {
  idle: { label: '未开始', tone: 'idle' },
  running: { label: '进行中', tone: 'running' },
  ok: { label: '已命中', tone: 'ok' },
  zero: { label: '无命中', tone: 'zero' },
  throttled: { label: '待手动', tone: 'throttled' },
  failed: { label: '失败', tone: 'failed' },
  disabled: { label: '已停用', tone: 'disabled' },
};

/* ===== 字典：降级三族 ===== */
export const DEGRADE_FAMILY = {
  success: { label: '成功族', desc: '自动链路走通，结果已入库' },
  degraded: { label: '降级族', desc: '换了路径拿到结果，或需要你手动补一步' },
  failed: { label: '失败族', desc: '自动链路全部不可用，未产生结果' },
};

export const FAMILY_OF_STATUS = {
  succeeded: 'success',
  zero_result: 'success',
  manual: 'degraded',
  failed: 'failed',
  cancelled: 'failed',
};

/* ===== 字典：错误码 → 人话（降级三要素的第一段） ===== */
// PROXY_UNREACHABLE / FORBIDDEN 曾经漏在这里：errorText 回退成"未知原因"，
// 用户看到的降级理由就成了"页面结构无法解析、未知原因、网络不可达"——
// 明明是代理隧道没建起来，却说不知道为什么。缺文案比报错更误导，补齐。
export const ERROR_COPY = {
  PROVIDER_DISABLED: '引擎已停用或正在熔断',
  NETWORK_ERROR: '网络不可达',
  PROXY_UNREACHABLE: '代理隧道未建立',
  OFFLINE: '当前离线模式',
  TIMEOUT: '请求超时',
  // 键名必须是 RATE_LIMITED：服务端发的是这个（errors.mjs），
  // 这里曾写成 RATE_LIMIT，于是限流也被回退成"未知原因"。
  RATE_LIMITED: '触发限流',
  FORBIDDEN: '引擎拒绝访问',
  BAD_REQUEST: '请求参数不合法',
  CONSENT_REQUIRED: '需要你的授权',
  MEDIA_ERROR: '媒体处理失败',
  CONFLICT: '状态冲突',
  CAPTCHA: '需要人机验证',
  UPLOAD_REJECTED: '图床拒绝上传',
  PARSE_ERROR: '页面结构无法解析',
  ENGINE_NO_HTTP_RESULT: '引擎结果需浏览器渲染，HTTP 层取不到',
  HTTP_ERROR: 'HTTP 返回异常',
  NOT_FOUND: '目标缺失',
  INTERNAL: '内部异常',
  CANCELLED: '已取消',
  INTERFACE_NOT_FOUND: '接口地址不存在',
  EXPORT_FAILED: '导出失败',
};

export const errorText = (code, fallback = '未知原因') => ERROR_COPY[code] || fallback;

/* ===== 字典：四种空状态（文案互不相同，不得复用） ===== */
export const EMPTY_COPY = {
  noTask: {
    icon: 'film',
    title: '还没有任何溯源任务',
    desc: '把本地视频拖进上传区，或填一个公网视频地址。抽帧在本机完成，帧是否外发由你逐次确认。',
    action: '选择视频文件',
  },
  noFrame: {
    icon: 'frame',
    title: '这个任务还没有抽出帧',
    desc: '抽帧被取消、源文件不可解析，或输出目录被清空都会得到 0 帧。重新抽帧后再发起检索。',
    action: '重新抽帧',
  },
  noHit: {
    icon: 'search-x',
    title: '检索跑完了，但没有任何命中',
    desc: '引擎返回了空结果，这不代表帧有问题。可以换一帧重试，或在设置里开启图床桥接提高可达性。',
    action: '重试失败与待手动项',
  },
  noAnalysis: {
    icon: 'search',
    title: '帧已就绪，还没有发起检索',
    desc: '点「发起检索」后，需要先在弹窗里勾选引擎范围——帧只有在你确认后才会离开本机。',
    action: '发起检索',
  },
  noFiltered: {
    icon: 'filter',
    title: '当前筛选条件下没有结果',
    desc: '试着放宽排序分下限、清空关键词或域名，再切换到其他引擎看看。',
    action: '清空筛选条件',
  },
};

/* ===== 引擎与图床 ===== */
export const ENGINE_LABEL = { google_lens: 'Google Lens', yandex: 'Yandex 图片', bing: 'Bing 图片' };
export const engineLabel = (id) => ENGINE_LABEL[id] || id;

export const AVAILABILITY_TEXT = {
  verified: { label: '实测可用', tone: 'ok' },
  unverified: { label: '未验证', tone: 'throttled' },
  unavailable: { label: '实测不可用', tone: 'failed' },
};

// 图床选项的单一来源。三处下拉（设置页默认站点 / 任务确认弹窗 / 引擎页展示）
// 必须都从这里取，否则又会出现「UI 承诺与执行层实际是两套数据源」——
// 后端加了 github 图床、界面下拉里却没有，用户根本选不到，桥接依旧全降级为手动。
// 顺序即推荐顺序：github 是唯一实测跑通的一家，放首位。
export const IMAGEHOST_OPTIONS = [
  { id: 'github', label: 'GitHub 直链（自有仓库）', hint: '需先设 RVS_GITHUB_TOKEN 与 RVS_GITHUB_REPO；帧会公开可见并留在 git 历史' },
  { id: 'catbox', label: 'catbox.moe', hint: '匿名上传实测被拒（412），需自备账号填 RVS_CATBOX_USERHASH' },
  { id: '0x0', label: '0x0.st', hint: '实测不可达（TLS 连接即断）' },
  { id: 'tmpfiles', label: 'tmpfiles.org', hint: '上传成功但链接是 HTML 预览页，引擎取不到图' },
];

export const IMAGEHOST_LABEL = Object.fromEntries(IMAGEHOST_OPTIONS.map((o) => [o.id, o.label]));

export const EXTRACT_MODE_TEXT = { interval: '固定间隔', scene: '场景切换', both: '场景 + 间隔' };
export const extractModeText = (m) => EXTRACT_MODE_TEXT[m] || m || '—';

export const LOG_LEVEL_TEXT = { debug: '调试', info: '信息', warn: '警告', error: '错误' };
