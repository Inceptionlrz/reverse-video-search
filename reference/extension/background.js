const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const GOOGLE_ENTRY_URLS = ['https://lens.google.com/', 'https://www.google.com/imghp', 'https://www.google.com.hk/imghp'];
let activeTabIds = [];
let runId = 0;

async function closeActiveTabs() {
  const tabs = activeTabIds.splice(0);
  await Promise.all(tabs.map(id => chrome.tabs.remove(id).catch(() => {})));
}

async function evaluate(tabId, expression) {
  const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result?.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text || '页面脚本执行失败';
    throw new Error(description);
  }
  return result?.result?.value;
}

async function runPageScript(tabId, func, args = []) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func,
    args
  });
  return result?.[0]?.result;
}

function isTransientTabError(error) {
  return /Tabs cannot be edited right now|user may be dragging a tab/i.test(String(error || ''));
}

async function closeTabQuietly(tabId) {
  if (!tabId) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await chrome.tabs.remove(tabId);
      activeTabIds = activeTabIds.filter(id => id !== tabId);
      return;
    } catch (error) {
      if (!isTransientTabError(error)) {
        activeTabIds = activeTabIds.filter(id => id !== tabId);
        return;
      }
      await sleep(1200 * (attempt + 1));
    }
  }
}

async function waitForTab(tabId) {
  const current = await chrome.tabs.get(tabId);
  if (current.status === 'complete') return;
  await new Promise(resolve => {
    const done = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(done);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(done);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(done);
      resolve();
    }, 15000);
  });
}

async function waitForResultsUrl(tabId, before) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const current = (await chrome.tabs.get(tabId).catch(() => ({ url: '' }))).url || '';
    if (current && current !== before && !/\/v3\/upload(?:$|\?)/i.test(current) && !/^chrome-error:/i.test(current)) {
      try {
        if (/google\./i.test(new URL(current).hostname)) return current;
      } catch {}
    }
    await sleep(500);
  }
  return '';
}

async function downloadFrame(dataUrl, index) {
  return await new Promise((resolve, reject) => chrome.downloads.download({
    url: dataUrl,
    filename: `reverse-video-search/frame-${String(index + 1).padStart(2, '0')}.jpg`,
    saveAs: false,
    conflictAction: 'overwrite'
  }, id => {
    if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
    const poll = async () => {
      const item = (await chrome.downloads.search({ id }))[0];
      if (item?.state === 'complete') return resolve(item.filename);
      if (item?.state === 'interrupted') return reject(new Error(item.error || 'download interrupted'));
      setTimeout(poll, 250);
    };
    poll();
  }));
}

async function findFileInput(tabId) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const root = await chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument', { depth: -1 });
    const input = await chrome.debugger.sendCommand({ tabId }, 'DOM.querySelector', {
      nodeId: root.root.nodeId,
      selector: 'input[type=file]'
    });
    if (input.nodeId) return input.nodeId;
    try {
      const flat = await chrome.debugger.sendCommand({ tabId }, 'DOM.getFlattenedDocument', { depth: -1, pierce: true });
      const node = flat.nodes.find(n => n.nodeName === 'INPUT' && Array.isArray(n.attributes) && n.attributes.some((v, i) => v === 'type' && n.attributes[i + 1] === 'file'));
      if (node?.nodeId) return node.nodeId;
    } catch {}
    await sleep(500);
  }
  throw new Error('Google 上传控件未找到');
}

async function readGoogleResults(tabId) {
  return await runPageScript(tabId, () => {
    const googleHost = /^(?:.*\\.)?(?:google|gstatic)(?:\\.[a-z]{2,3}){1,2}$/i;
    const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
    const textOf = node => {
      const label = norm(node.getAttribute?.('aria-label'));
      if (label) return label;
      const alt = norm(node.querySelector?.('img')?.alt);
      if (alt) return alt;
      return norm(node.innerText || node.textContent);
    };
    const unwrap = href => {
      try {
        const u = new URL(href, location.href);
        if (googleHost.test(u.hostname) && /^\\/(?:url|goto)$/.test(u.pathname)) {
          const target = u.searchParams.get('q') || u.searchParams.get('url') || u.searchParams.get('imgurl');
          if (target && /^https?:/i.test(target)) return target;
        }
        return u.href;
      } catch { return href; }
    };
    const raw = [...document.querySelectorAll('a[href]')].map(a => {
      const href = a.href;
      const text = textOf(a);
      let internal = false;
      try {
        const u = new URL(href, location.href);
        internal = googleHost.test(u.hostname);
      } catch {}
      return { href, text, internal, node: a };
    });
    const links = raw
      .filter(item => /^https?:/i.test(item.href))
      .filter(item => {
        try {
          const u = new URL(item.href);
          if (!item.internal) return true;
          if (/^\\/(?:url|goto)$/.test(u.pathname)) return Boolean(u.searchParams.get('q') || u.searchParams.get('url') || u.searchParams.get('imgurl'));
          const query = u.search;
          return /(?:imgurl|mediaurl|source|ep=|vsrid=|udm=)/i.test(query) && !/^(?:https?:)?\\/\\/(?:www\\.)?google\\./i.test(u.searchParams.get('q') || '');
        } catch { return false; }
      })
      .map(item => ({ href: unwrap(item.href), text: item.text || 'Google Lens 图片匹配' }))
      .filter(item => /^https?:/i.test(item.href))
      .filter((item, index, all) => all.findIndex(other => other.href === item.href) === index)
      .slice(0, 50);
    const body = (document.body?.innerText || '').trim();
    const visualText = /(?:visual matches|exact matches|外观匹配|完全匹配|相关图片|visual search)/i.test(body);
    const imageCards = raw.filter(item => {
        const image = item.node.querySelector('img');
        const src = image?.currentSrc || image?.src || '';
        if (!image || /(?:googlelogo|favicon|branding|gstatic\.com\/images)/i.test(src)) return false;
        if (!item.internal) return true;
        try {
          const u = new URL(item.href);
          return /\/(?:goto|url)$/.test(u.pathname) || /(?:vsrid|udm=|imgurl|mediaurl)/i.test(u.search);
        } catch { return false; }
      })
      .map(item => ({ href: unwrap(item.href), text: item.text || 'Google Lens 图片匹配' }))
      .filter(item => /^https?:/i.test(item.href))
      .filter((item, index, all) => all.findIndex(other => other.href === item.href) === index)
      .slice(0, 50);
    const merged = [...links, ...imageCards]
      .filter((item, index, all) => all.findIndex(other => other.href === item.href) === index)
      .slice(0, 50);
    const structuralCards = [...document.querySelectorAll('[data-snf]')]
      .filter(node => node.querySelector('a[href],img'));
    const count = merged.length || structuralCards.length;
    return { url: location.href, title: document.title, count, links: merged, excerpt: body.slice(0, 1600), visualText, anchorCount: raw.length, imageCardCount: imageCards.length, structuralCardCount: structuralCards.length };
  });
}
async function waitForGoogleResults(tabId) {
  let latest = { count: 0, links: [], excerpt: '', visualText: false };
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const parsed = await readGoogleResults(tabId);
      if (parsed && typeof parsed === 'object') {
        latest = { ...latest, ...parsed, count: Number(parsed.count) || 0, links: Array.isArray(parsed.links) ? parsed.links : [] };
        if (latest.count > 0) return latest;
      }
    } catch {}
    await sleep(1000);
  }
  return latest;
}

async function revealResultSection(tabId) {
  try {
    return await runPageScript(tabId, () => {
      const nodes = [...document.querySelectorAll('button,[role="button"],a,[tabindex]')];
      const target = nodes.find(node => /Search results|See results about this image|Find image source|Visual matches|Exact matches|搜索结果|查找图片来源|视觉匹配|外观匹配|完全匹配/i.test((node.innerText || node.getAttribute('aria-label') || '').trim()));
      if (target) { target.click(); return true; }
      return false;
    });
  } catch {
    return false;
  }
}

async function submitLensForm(tabId, dataUrl) {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [dataUrl, 'https://lens.google.com/v3/upload'],
      func: (url, endpoint) => {
        try {
          const b64 = (url.split(',')[1] || url).replace(/\s/g, '');
          const binary = atob(b64);
          const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
          const form = document.createElement('form');
          form.method = 'POST';
          form.action = endpoint;
          form.enctype = 'multipart/form-data';
          const file = document.createElement('input');
          file.type = 'file';
          file.name = 'encoded_image';
          const transfer = new DataTransfer();
          transfer.items.add(new File([bytes], 'frame.jpg', { type: 'image/jpeg' }));
          file.files = transfer.files;
          form.appendChild(file);
          const source = document.createElement('input');
          source.type = 'hidden';
          source.name = 'sbisrc';
          source.value = 'Google Chrome';
          form.appendChild(source);
          document.body.appendChild(form);
          form.submit();
          return true;
        } catch { return false; }
      }
    });
    return result?.[0]?.result === true;
  } catch {
    return false;
  }
}

async function injectFileIntoPage(tabId, dataUrl, index) {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [dataUrl, `reverse-frame-${String(index + 1).padStart(2, '0')}.jpg`],
      func: async (url, name) => {
        const findInput = root => {
          const direct = root.querySelector?.('input[type="file"]');
          if (direct) return direct;
          for (const element of root.querySelectorAll?.('*') || []) {
            if (element.shadowRoot) {
              const nested = findInput(element.shadowRoot);
              if (nested) return nested;
            }
          }
          return null;
        };
        const input = findInput(document);
        if (!input) return false;
        const blob = await (await fetch(url)).blob();
        const file = new File([blob], name, { type: blob.type || 'image/jpeg' });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;
        if (setter) setter.call(input, transfer.files);
        else input.files = transfer.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return Boolean(input.files?.length);
      }
    });
    return result?.[0]?.result === true;
  } catch {
    return false;
  }
}

async function automateTab(tabId, dataUrl, index) {
  const before = (await chrome.tabs.get(tabId)).url || '';
  if (await submitLensForm(tabId, dataUrl)) {
    const landed = await waitForResultsUrl(tabId, before);
    if (landed) {
      await sleep(1800);
      return landed;
    }
  }

  await chrome.debugger.attach({ tabId }, '1.3');
  try {
    await chrome.debugger.sendCommand({ tabId }, 'DOM.enable');
    await sleep(1800);
    const result = await evaluate(tabId, `(() => {
      const file = document.querySelector('input[type=file]');
      if (file) return 'input';
      const nodes = [...document.querySelectorAll('button,[role="button"],a,label,[tabindex]')];
      const button = nodes.find(node => /按图搜索|以图搜索|Search by image|搜图/i.test((node.innerText || node.getAttribute('aria-label') || '').trim()));
      if (button) { button.click(); return 'search'; }
      return 'none';
    })()`);
    if (result !== 'input') {
      await sleep(1200);
      await evaluate(tabId, `(() => {
        const nodes = [...document.querySelectorAll('button,[role="button"],a,label,[tabindex]')];
        const button = nodes.find(node => /上传图片|Upload an image|Upload file|上传文件/i.test((node.innerText || node.getAttribute('aria-label') || '').trim()));
        if (button) { button.click(); return true; }
        return false;
      })()`);
    }
    const nodeId = await findFileInput(tabId);
    if (!await injectFileIntoPage(tabId, dataUrl, index)) {
      const path = await downloadFrame(dataUrl, index);
      await chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', { nodeId, files: [path] });
    }
    await sleep(2500);
  } finally {
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
  return '';
}

async function uploadThroughGoogle(dataUrl, index, currentRun) {
  let lastError;
  for (let entryIndex = 0; entryIndex < GOOGLE_ENTRY_URLS.length; entryIndex++) {
    const url = GOOGLE_ENTRY_URLS[entryIndex];
    if (currentRun !== runId) throw new Error('cancelled');
    let tab;
    try {
      for (let attempt = 0; attempt < 2 && !tab; attempt++) {
        try {
          tab = await chrome.tabs.create({ url, active: false });
        } catch (error) {
          if (!isTransientTabError(error) || attempt === 1) throw error;
          await sleep(1500);
        }
      }
      activeTabIds.push(tab.id);
      if (currentRun !== runId) throw new Error('cancelled');
      await waitForTab(tab.id);
      await automateTab(tab.id, dataUrl, index);
      if (currentRun !== runId) throw new Error('cancelled');
      return { tab };
    } catch (error) {
      lastError = error;
      if (tab?.id) {
        activeTabIds = activeTabIds.filter(id => id !== tab.id);
        await closeTabQuietly(tab.id);
      }
    }
  }
  throw lastError || new Error('Google 页面无法打开');
}

async function collectGoogleResults(tabId) {
  let results = await waitForGoogleResults(tabId);
  if (!results.count && await revealResultSection(tabId)) {
    await sleep(1200);
    results = await waitForGoogleResults(tabId);
  }
  return results;
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'cancel-search') {
    runId++;
    closeActiveTabs();
    return;
  }
  if (message?.type !== 'search-frames') return;
  const currentRun = ++runId;
  (async () => {
    await closeActiveTabs();
    const baseIndex = Number.isInteger(message.baseIndex) ? message.baseIndex : 0;
    for (let offset = 0; offset < message.frames.length; offset++) {
      const index = baseIndex + offset;
      if (currentRun !== runId) return;
      try {
        const opened = await uploadThroughGoogle(message.frames[offset], index, currentRun);
        if (sender.tab) chrome.tabs.sendMessage(sender.tab.id, { type: 'bridge-status', status: 'opened', index });
        collectGoogleResults(opened.tab.id).then(results => {
          if (currentRun === runId && sender.tab) chrome.tabs.sendMessage(sender.tab.id, { type: 'bridge-status', status: 'results', index, results });
        }).catch(error => {
          if (currentRun === runId && sender.tab) chrome.tabs.sendMessage(sender.tab.id, { type: 'bridge-status', status: 'error', index, error: String(error) });
        }).finally(() => {
          closeTabQuietly(opened.tab.id);
        });
      } catch (error) {
        if (currentRun !== runId) return;
        if (sender.tab) chrome.tabs.sendMessage(sender.tab.id, { type: 'bridge-status', status: 'error', index, error: String(error) });
      }
    }
  })();
});
