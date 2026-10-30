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
    const body = JSON.stringify({
      message: `frame ${filename}`,
      content: Buffer.from(buffer).toString('base64'),
      branch: this.branch,
    });

    // 本类覆盖了基类的 upload，计数也得自己来——否则出站统计里图床恒为 0，
    // "上传次数"这个可观测指标对 GitHub 图床完全失效。
    const metrics = ctx?.metrics;
    if (metrics) {
      metrics.imagehostRequests[this.id] = (metrics.imagehostRequests[this.id] || 0) + 1;
    }

    const res = await trackedRequest(ctx, endpoint, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'User-Agent': 'reverse-video-search',
      },
      body,
    });

    if (!res.ok) {
      return {
        ok: false,
        errorCode: res.errorCode || 'UPLOAD_REJECTED',
        errorMessage: `GitHub 上传失败：${res.errorMessage || `HTTP ${res.status}`}`,
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
