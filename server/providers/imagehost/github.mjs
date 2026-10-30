// GitHub 图床：把帧提交到自有仓库的指定分支，用 raw.githubusercontent.com 的
// 直链作为公网图片 URL。
//
// 为什么需要它：内置三家匿名图床实测全部不可用（catbox 需账号且注册有 reCAPTCHA、
// tmpfiles 返回 HTML 预览页、0x0 不可达），详见 scripts/probe/19、20。
// 与其再赌一家第三方，不如用用户自己已经拥有的 GitHub：
//   - 不用注册任何新账号（复用本机已有的 token）
//   - raw.githubusercontent.com 按扩展名返回 image/*，是真图片直链（已实测）
//   - 内容归属与删除权完全在用户手里
//
// 代价必须说清：帧会**公开可见**并**留在 git 历史里**（删掉分支历史才消失）。
// 因此默认分支用孤立的 frames 分支，与主分支历史隔离，也不触发 Pages 重建。
//
// 用法：设 RVS_GITHUB_TOKEN、RVS_GITHUB_REPO（owner/repo），可选 RVS_GITHUB_BRANCH。
import { BaseImageHost, verifyImageUrl } from './base.mjs';
import { trackedRequest } from '../base.mjs';

// 取出 GitHub 自己的错误描述。抽成纯函数是为了可测——
// 它决定了"上传失败"这条日志是能排障还是只能干瞪眼：
// HTTP 422 什么也说明不了，而响应体里的 `"sha" wasn't supplied.` 就能直接定位。
export function githubMessage(res) {
  try {
    const parsed = JSON.parse(String(res?.body || ''));
    const msg = parsed?.message;
    if (typeof msg === 'string' && msg.trim()) {
      // 不能只取首行：GitHub 的 message 常是 `Invalid request.\n\n"sha" wasn't supplied.`，
      // 首行什么也没说，真正的原因在第二段。
      return msg.split('\n').map((s) => s.trim()).filter(Boolean).join(' / ');
    }
  } catch {
    // 非 JSON（代理错误页等）时回落到传输层描述
  }
  // status 为 0 表示连接根本没建立（代理没通等），此时"HTTP 0"毫无意义。
  const status = Number.isFinite(res?.status) && res.status > 0 ? res.status : null;
  return res?.errorMessage || (status ? `HTTP ${status}` : '无响应');
}

export class GitHubHost extends BaseImageHost {
  constructor() {
    super({
      id: 'github',
      label: 'GitHub 直链（自有仓库）',
      endpoint: 'https://api.github.com',
      retention: '永久：留在 git 历史中，删除该分支才会消失',
      verified: false,
      notes: '帧会公开提交到你的 GitHub 仓库并留在 git 历史里；raw.githubusercontent.com 返回真图片直链；需先设 RVS_GITHUB_TOKEN 与 RVS_GITHUB_REPO',
    });
    // 构造期读取：图床在启动时装配，env 变化需重启生效（与其他图床一致）。
    this.token = process.env.RVS_GITHUB_TOKEN || '';
    this.repo = process.env.RVS_GITHUB_REPO || '';
    this.branch = process.env.RVS_GITHUB_BRANCH || 'frames';
  }

  configured() {
    return Boolean(this.token && this.repo);
  }

  headers() {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.token}`,
      'User-Agent': 'reverse-video-search',
    };
  }

  async put(ctx, endpoint, payload) {
    return trackedRequest(ctx, endpoint, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
  }

  // 取已有文件的 sha。覆盖写必须带 sha，否则 GitHub 返回 422。
  // ⚠️ 必须带 ?ref=<分支>：不带时读的是默认分支（main），而帧在 frames 孤立分支上，
  //    拿不到 sha 就只能一直 422——这个坑实测踩到过。
  async fetchSha(ctx, endpoint) {
    const url = `${endpoint}?ref=${encodeURIComponent(this.branch)}`;
    const res = await trackedRequest(ctx, url, { method: 'GET', headers: this.headers() });
    if (!res.ok) return null;
    try {
      return JSON.parse(String(res.body || '')).sha || null;
    } catch {
      return null;
    }
  }

  // 不用基类的 multipart 上传：GitHub Contents API 走 JSON + base64。
  async upload(ctx, { buffer, filename }) {
    if (!this.configured()) {
      return {
        ok: false,
        errorCode: 'UPLOAD_REJECTED',
        errorMessage: 'GitHub 图床未配置：需要 RVS_GITHUB_TOKEN 与 RVS_GITHUB_REPO（owner/repo）',
      };
    }
    // 逐段编码：路径里的日期目录分隔符必须保留，整体 encodeURIComponent 会把 / 吃掉
    const day = new Date().toISOString().slice(0, 10);
    const relPath = `${day}/${filename}`.split('/').map(encodeURIComponent).join('/');
    const endpoint = `https://api.github.com/repos/${this.repo}/contents/${relPath}`;
    const payload = {
      message: `frame ${filename}`,
      content: Buffer.from(buffer).toString('base64'),
      branch: this.branch,
    };

    // 本类覆盖了基类的 upload，计数也得自己来——否则出站统计里图床恒为 0，
    // "上传次数"这个可观测指标对 GitHub 图床完全失效。
    const metrics = ctx?.metrics;
    if (metrics) {
      metrics.imagehostRequests[this.id] = (metrics.imagehostRequests[this.id] || 0) + 1;
    }

    let res = await this.put(ctx, endpoint, payload);

    // 同名已存在 → GitHub 要 sha 才让覆盖（实测第 2 次 PUT 返回 422
    // `"sha" wasn't supplied.`，并发下也会是 409）。
    // 同一个帧会被多个引擎各上传一次、路径完全相同，所以第二个引擎开始必撞这条——
    // 实测 12 帧任务里 7 帧因此失败，而界面只显示"上传失败：HTTP 422"。
    // 内容相同的覆盖是幂等的：补 sha 重 PUT，而不是换个文件名堆垃圾。
    if (res.status === 409 || res.status === 422) {
      for (let attempt = 0; attempt < 2 && !res.ok; attempt += 1) {
        const sha = await this.fetchSha(ctx, endpoint);
        if (!sha) break;
        res = await this.put(ctx, endpoint, { ...payload, sha });
        if (!res.ok) await new Promise((r) => setTimeout(r, 400));
      }
    }

    if (!res.ok) {
      return {
        ok: false,
        errorCode: res.errorCode || 'UPLOAD_REJECTED',
        // HTTP 状态本身不说明原因（422 可能是缺 sha、可能是内容非法），
        // 真正的原因在响应体 message 里——不把它带出来就无从排障。
        errorMessage: `GitHub 上传失败：${githubMessage(res)}`,
      };
    }

    let url = null;
    try {
      const parsed = JSON.parse(String(res.body || ''));
      url = parsed?.content?.download_url || parsed?.content?.html_url || null;
    } catch {
      url = null;
    }
    if (!url) {
      return { ok: false, errorCode: 'UPLOAD_REJECTED', errorMessage: 'GitHub 返回了无法解析的响应' };
    }

    // 与基类同一判据：链接必须真能取到图片，否则不能据此发起检索。
    // 刚提交的文件在 raw 上偶有延迟，404 时补一次短重试再判失败。
    let verdict = await verifyImageUrl(ctx, url);
    if (!verdict.ok) {
      await new Promise((r) => setTimeout(r, 1200));
      verdict = await verifyImageUrl(ctx, url);
    }
    if (!verdict.ok) {
      return {
        ok: false,
        errorCode: 'UPLOAD_REJECTED',
        errorMessage: `GitHub 的直链${verdict.reason}，不能据此发起检索`,
        detail: url,
      };
    }
    return { ok: true, url, requestUrl: endpoint, httpStatus: res.status };
  }
}

export function createGitHubHost() {
  return new GitHubHost();
}
