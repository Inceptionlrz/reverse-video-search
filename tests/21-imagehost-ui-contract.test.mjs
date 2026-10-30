// 图床选项的 UI / 执行层一致性契约。
//
// 缺陷原貌：后端注册表加了 github 图床（唯一实测跑通的一家），
// 但设置页与确认弹窗的下拉里只有 catbox / 0x0 / tmpfiles 三项硬编码——
// 用户压根选不到它，桥接依旧 100% 降级为手动，而界面上没有任何提示说明原因。
// 这就是「UI 承诺与执行层实际是两套数据源」的又一例：两边各自维护一份列表，
// 加后端忘了加前端，功能等于没上线。
//
// 本文件把两边钉在一起：下拉选项必须来自同一份 IMAGEHOST_OPTIONS，
// 且其 id 集合必须等于后端注册表实际装配出来的 id 集合。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { IMAGEHOST_OPTIONS, IMAGEHOST_LABEL } from '../public/assets/format.js';
import { createImageHostRegistry, listImageHostIds } from '../server/providers/imagehost/registry.mjs';
import { DEFAULT_SETTINGS } from '../server/services/settings.service.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('图床选项：UI 与执行层必须是同一份', () => {
  test('U1：下拉选项的 id 集合等于后端注册表', () => {
    const backendIds = [...createImageHostRegistry().keys()].sort();
    const uiIds = IMAGEHOST_OPTIONS.map((o) => o.id).sort();
    assert.deepEqual(uiIds, backendIds, '后端加了图床而 UI 没有，等于功能没上线');
  });

  test('U2：唯一实测可用的 github 必须在选项里且在首位', () => {
    // 三家匿名图床实测全不可用（README 有结论表），github 是当前唯一能跑通的。
    // 放首位是给用户的可达路径提示，不是装饰。
    assert.equal(IMAGEHOST_OPTIONS[0].id, 'github');
    const github = IMAGEHOST_OPTIONS.find((o) => o.id === 'github');
    assert.match(github.hint, /RVS_GITHUB_TOKEN/, '必须写明需要什么才可用');
    assert.match(github.hint, /git 历史/, '必须写明帧会留在 git 历史这一代价');
  });

  test('U3：每一家都要有可用性说明，不许只给个名字', () => {
    for (const o of IMAGEHOST_OPTIONS) {
      assert.ok(o.label && o.label.trim(), `${o.id} 缺 label`);
      assert.ok(o.hint && o.hint.trim().length > 10, `${o.id} 缺可用性与代价说明`);
    }
  });

  test('U4：设置页下拉必须遍历 IMAGEHOST_OPTIONS，不得再硬编码', () => {
    const src = read('public/assets/views/settings.view.js');
    assert.match(src, /IMAGEHOST_OPTIONS\.map/, '设置页下拉应来自共享选项表');
    assert.doesNotMatch(src, /h\('option', \{ value: 'catbox'/, '不得再硬编码单个图床选项');
  });

  test('U5：确认弹窗下拉同样必须遍历 IMAGEHOST_OPTIONS', () => {
    const src = read('public/assets/views/shared.view.js');
    assert.match(src, /IMAGEHOST_OPTIONS\.map/, '确认弹窗下拉应来自共享选项表');
    assert.doesNotMatch(src, /h\('option', \{ value: 'catbox'/, '不得再硬编码单个图床选项');
  });

  test('U6：IMAGEHOST_LABEL 由选项表派生，覆盖全部 id', () => {
    // 引擎页展示用 IMAGEHOST_LABEL。若它是手写的另一份表，又会漂移。
    for (const o of IMAGEHOST_OPTIONS) {
      assert.equal(IMAGEHOST_LABEL[o.id], o.label, `${o.id} 的展示名应与选项表一致`);
    }
    assert.equal(Object.keys(IMAGEHOST_LABEL).length, IMAGEHOST_OPTIONS.length);
  });
});

describe('图床站点保存：白名单不能漏掉新图床', () => {
  test('S1：设置页选 github 保存后必须真的存下来', () => {
    // 曾经 IMAGEHOST_IDS 手写为 ['catbox','0x0','tmpfiles']，
    // 校验时 `if (IMAGEHOST_IDS.includes(host.provider)) next.imagehost.provider = ...`，
    // 白名单不认识 github → 整条赋值被跳过，provider 仍为 null。
    // 界面提示"已保存"，桥接却不可用，且没有任何报错——最难排查的一类失败。
    assert.ok(IMAGEHOST_OPTIONS.some((o) => o.id === 'github'), '前提：UI 里确实有 github');
    assert.ok(listImageHostIds().includes('github'), '注册表名单必须含 github');

    const src = read('server/services/settings.service.mjs');
    assert.doesNotMatch(src, /\['catbox',\s*'0x0',\s*'tmpfiles'\]/, '不得再手写图床白名单');
    assert.match(src, /listImageHostIds\(\)/, '白名单应从注册表派生');
  });

  test('S2：默认值与白名单一致（默认未选，不指认某一家）', () => {
    assert.equal(DEFAULT_SETTINGS.imagehost.provider, null, '默认不选站点：桥接不可用的状态必须显式');
  });

  test('S3：confirm 路由的站点报错文案不得写死三家', () => {
    const src = read('server/routes/api-tasks.routes.mjs');
    assert.doesNotMatch(src, /catbox \/ 0x0 \/ tmpfiles/, '报错文案里的站点名单应从注册表派生');
    assert.match(src, /listImageHostIds/, '应改用 listImageHostIds');
  });
});
