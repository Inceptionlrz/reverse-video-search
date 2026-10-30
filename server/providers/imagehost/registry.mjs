// 图床注册表。用户显式选择其一后才会被编排层调用。
// 三家匿名图床实测均不可用（见 probes 19/20），github 是当前唯一实测能跑通的一家，
// 所以放在列表首位——不是因为它更"官方"，而是因为只有它验证过。
import { createGitHubHost } from './github.mjs';
import { createCatboxHost } from './catbox.mjs';
import { createX0Host } from './0x0.mjs';
import { createTmpFilesHost } from './tmpfiles.mjs';

export function createImageHostRegistry() {
  const hosts = new Map();
  for (const factory of [createGitHubHost, createCatboxHost, createX0Host, createTmpFilesHost]) {
    const host = factory();
    hosts.set(host.id, host);
  }
  return hosts;
}

export function getImageHost(hosts, id) {
  return hosts.get(id) || null;
}

// 站点 id 名单的唯一来源。设置白名单校验与 confirm 路由的报错文案都从这里取，
// 谁都不许再手写一份——手写名单漏掉新图床时，用户选了也会被静默丢弃。
export function listImageHostIds() {
  return [...createImageHostRegistry().keys()];
}

export function listImageHosts(hosts) {
  return [...hosts.values()].map((h) => ({
    id: h.id,
    label: h.label,
    retention: h.retention,
    verified: h.verified,
    notes: h.notes,
  }));
}
