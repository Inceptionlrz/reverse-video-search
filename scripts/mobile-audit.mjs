// 移动端真机布局审计（Chromium 无头渲染）。
//
// 为什么单独一个脚本：README 声称"手机浏览器可用"，但项目本身零 npm 依赖、
// 不进 npm test，本地也没有常驻浏览器。没有这一层，响应式断点就只是 CSS 文本，
// 谁改了都没人知道——之前"筛选栏内联 width 导致窄屏横滚"就是纯靠读代码才发现的。
//
// 用法（需先 npm i -D playwright && npx playwright install chromium）：
//   node --experimental-sqlite server/bin/rvs.mjs   # 另开终端起服务
//   node scripts/mobile-audit.mjs [baseUrl]
//
// 不属于 npm test：CI 上要能跑需要下载浏览器，而本项目刻意保持零依赖。
// 因此它是"人工核查工具"，不是门禁。

import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:4173';

// 覆盖真机主流量：320 是小屏安卓下限，360/390/414 是主流安卓与 iPhone，
// 768 是断点边界（≤767 才切底栏导航，768 必须仍是侧栏）。
const VIEWPORTS = [
  { name: '320x640  小屏安卓下限', width: 320, height: 640 },
  { name: '360x780  主流安卓', width: 360, height: 780 },
  { name: '390x844  iPhone 12/13/14', width: 390, height: 844 },
  { name: '414x896  iPhone Plus', width: 414, height: 896 },
  { name: '768x1024 断点边界(应仍为侧栏)', width: 768, height: 1024 },
  { name: '1280x800 桌面基准', width: 1280, height: 800 },
];

const ROUTES = [
  ['/', '溯源工作台'],
  ['/results', '结果总览'],
  ['/engines', '引擎诊断'],
  ['/logs', '运行日志'],
  ['/settings', '设置'],
];

const results = [];

function record(viewport, route, kind, detail) {
  results.push({ viewport: viewport.name, route, kind, detail });
}

const browser = await chromium.launch();

for (const vp of VIEWPORTS) {
  // hasTouch: true 才能触发 @media (pointer: coarse) 的 44px 触控目标规则
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    hasTouch: true,
    isMobile: vp.width < 768,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  for (const [route, label] of ROUTES) {
    await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle' });
    // 等前端渲染：视图是 JS 挂载的，networkidle 后仍可能差一帧
    await page.waitForTimeout(400);

    // 遮挡检查：把主区滚到底，最后一屏内容若仍被固定底栏盖住就是缺陷。
    // 只看首屏截图无法判断（内容在折叠线下方属正常滚动），必须真的滚到底再比位置。
    if (vp.width < 768) {
      await page.evaluate(() => {
        const m = document.querySelector('.main');
        if (!m) return;
        m.scrollTop = m.scrollHeight;
        // 嵌套滚动容器也要滚到底：设置页的面板自带 overflow，只滚 .main
        // 会让里面的内容停在折叠线下方，测出来"被遮 525px"其实是没滚到位。
        for (const el of m.querySelectorAll('*')) {
          const cs = getComputedStyle(el);
          if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
            el.scrollTop = el.scrollHeight;
          }
        }
      });
      await page.waitForTimeout(200);
      const occl = await page.evaluate(() => {
        const sb = document.querySelector('.sidebar');
        const m = document.querySelector('.main');
        if (!sb || !m) return null;
        const sbTop = sb.getBoundingClientRect().top;
        // 取"最靠下"的元素，不是"DOM 里最后一个"。
        // 用后者会漏判：末尾元素常被外层容器的 padding 顶在上面，而真正的
        // 最深节点是别的中层元素——曾因此让"去掉所有底部留白"的变异测试也通过，
        // 检查形同虚设。
        let last = null;
        for (const el of m.querySelectorAll('*')) {
          const r = el.getBoundingClientRect();
          if (r.height === 0 || r.width === 0) continue;
          // 只看真正承载内容的叶子节点：容器的盒子常带着 padding 探到底栏下面，
          // 那 6px 是空白内边距，不是被遮住的信息。
          if (el.children.length > 0) continue;
          if (!(el.textContent || '').trim()) continue;
          // 折叠的 <details> 必须排除：Chromium 对未渲染的子节点仍返回非 0 的
          // rect（contentVisibility 报 visible），按几何位置看像"内容掉在视口外
          // 滚不到"，实际根本没渲染。曾误报设置页"未配置"被遮 501px。
          if (el.closest('details:not([open])')) continue;
          if (!last || r.bottom > last.bottom) last = { bottom: r.bottom, el };
        }
        if (!last) return null;
        const gap = Math.round(sbTop - last.bottom);
        if (gap >= -1) return null;
        return {
          gap,
          tag: last.el.tagName.toLowerCase(),
          cls: (last.el.className || '').toString().slice(0, 40),
          text: (last.el.textContent || '').trim().slice(0, 24),
        };
      });
      if (occl) {
        record(vp, route, 'OCCLUDED',
          `滚到底后最后一个元素被底栏遮住 ${-occl.gap}px：<${occl.tag} class="${occl.cls}">${occl.text}</…>`);
      }
      // 滚回顶部再做后续检查
      await page.evaluate(() => { const m = document.querySelector('.main'); if (m) m.scrollTop = 0; });
      await page.waitForTimeout(150);
    }

    const audit = await page.evaluate((vw) => {
      const doc = document.documentElement;
      const scrollW = doc.scrollWidth;
      const clientW = doc.clientWidth;

      // 横向溢出：找出所有右边界超出视口的元素（排除自身可横向滚动的容器）
      const overflowing = [];
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.right > vw + 1) {
          // 父链上有 overflow-x:auto/scroll 的是"故意可横滚"，不算缺陷
          let p = el.parentElement;
          let scrollable = false;
          while (p && p !== document.body) {
            const ox = getComputedStyle(p).overflowX;
            if (ox === 'auto' || ox === 'scroll') { scrollable = true; break; }
            p = p.parentElement;
          }
          if (!scrollable) {
            overflowing.push({
              tag: el.tagName.toLowerCase(),
              cls: (el.className || '').toString().slice(0, 40),
              right: Math.round(r.right),
            });
          }
        }
      }

      // 触控目标：只查可见且真的可点的小元素。
      // 复选框/单选框不算：点击目标是包裹它的 label，本身 13px 是设计意图，
      // 强行判 44px 会把密集的设置行撑散（这是误报，不是缺陷）。
      const small = [];
      const SEL = 'button, a[href], [role="button"], [role="tab"], [role="option"], select, textarea,'
        + 'input:not([type="checkbox"]):not([type="radio"])';
      for (const el of document.querySelectorAll(SEL)) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
        if (r.height < 44 || r.width < 44) {
          small.push({
            tag: el.tagName.toLowerCase(),
            cls: (el.className || '').toString().slice(0, 40),
            w: Math.round(r.width),
            h: Math.round(r.height),
            text: (el.textContent || '').trim().slice(0, 20),
          });
        }
      }

      // 底栏导航是否在 ≤767 出现
      const sidebar = document.querySelector('.sidebar');
      const sb = sidebar ? getComputedStyle(sidebar) : null;
      return {
        scrollW,
        clientW,
        hScroll: scrollW > clientW + 1,
        overflowing: overflowing.slice(0, 6),
        overflowCount: overflowing.length,
        small: small.slice(0, 6),
        smallCount: small.length,
        sidebarPos: sb ? sb.position : null,
        sidebarFlexDir: sb ? sb.flexDirection : null,
      };
    }, vp.width);

    if (audit.hScroll) {
      record(vp, route, 'H-SCROLL', `页面横向滚动 scrollWidth=${audit.scrollW} > clientWidth=${audit.clientW}`);
    }
    if (audit.overflowCount > 0) {
      record(vp, route, 'OVERFLOW', `${audit.overflowCount} 个元素右边界越界，前几个：${JSON.stringify(audit.overflowing)}`);
    }
    // 触控目标只在窄屏（真手机）断言：桌面鼠标环境 28-32px 是设计意图
    if (vp.width < 768 && audit.smallCount > 0) {
      record(vp, route, 'TOUCH', `${audit.smallCount} 个可点元素 <44px，前几个：${JSON.stringify(audit.small)}`);
    }
    if (vp.width < 768 && audit.sidebarPos !== 'fixed') {
      record(vp, route, 'NAV', `窄屏底栏导航未生效：.sidebar position=${audit.sidebarPos}（应为 fixed）`);
    }
    if (vp.width === 768 && audit.sidebarPos === 'fixed') {
      record(vp, route, 'NAV', `768px 不该切底栏，实际 position=${audit.sidebarPos}`);
    }

    await page.screenshot({
      path: `out/mobile/${vp.width}x${vp.height}${route.replace(/\//g, '_') || '_root'}.png`,
      fullPage: false,
    });
  }

  if (errors.length) {
    record(vp, '(整站)', 'JS-ERROR', errors.slice(0, 3).join(' | '));
  }
  await context.close();
}

await browser.close();

// ---- 报告 ----
console.log(`\n移动端布局审计  base=${BASE}\n${'='.repeat(72)}`);
if (results.length === 0) {
  console.log('无问题：所有视口 / 路由均无横向滚动、无越界元素、触控目标达标、无 JS 报错。');
} else {
  const byKind = {};
  for (const r of results) (byKind[r.kind] ||= []).push(r);
  for (const [kind, items] of Object.entries(byKind)) {
    console.log(`\n[${kind}] ${items.length} 条`);
    for (const r of items.slice(0, 12)) {
      console.log(`  ${r.viewport} ${r.route}\n    ${r.detail}`);
    }
    if (items.length > 12) console.log(`  …另有 ${items.length - 12} 条同类`);
  }
}
console.log(`\n截图目录：out/mobile/`);
process.exit(results.length ? 1 : 0);
