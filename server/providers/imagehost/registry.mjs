// 图床注册表：三家匿名图床。用户显式选择其一后才会被编排层调用。
import { createCatboxHost } from './catbox.mjs';
import { createX0Host } from './0x0.mjs';
import { createTmpFilesHost } from './tmpfiles.mjs';

export function createImageHostRegistry() {
  const hosts = new Map();
  for (const factory of [createCatboxHost, createX0Host, createTmpFilesHost]) {
    const host = factory();
    hosts.set(host.id, host);
  }
  return hosts;
}

export function getImageHost(hosts, id) {
  return hosts.get(id) || null;
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
