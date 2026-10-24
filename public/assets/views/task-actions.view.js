// task-actions.view.js — 任务详情页的动作簇：抽帧、队列控制、外发确认、手动检索入口。
// 从 task-detail.view.js 拆出，使其保持在单文件 300 行以内。
import { h, icon, toast, modal } from '../dom.js';
import { api, errText } from '../api.js';
import { bus, EVT } from '../store.js';
import { engineLabel, errorText } from '../format.js';
import { consentModal } from './shared.view.js';
import { manualActions } from './inspector.view.js';

/** 启动抽帧；btn 为触发按钮，进入 loading 态。 */
export async function doExtract(taskId, btn, onDone) {
  btn.disabled = true;
  btn.replaceChildren(icon('loader', 16, 'btn__spin'), '抽帧中');
  try {
    await api.extractTask(taskId, {});
    toast('抽帧已开始，进度在状态栏与任务卡片上更新', 'ok');
    if (onDone) await onDone();
  } catch (err) {
    toast(errText(err, '抽帧启动失败'), 'error');
    btn.disabled = false;
    btn.replaceChildren(icon('film', 16), '重试抽帧');
  }
}

/** 队列控制：pause / resume / cancel / retry-failed。 */
export async function controlTask(taskId, action, onDone) {
  const LABEL = { pause: '队列已暂停', resume: '队列已继续', cancel: '任务已取消', 'retry-failed': '失败项已重新入队' };
  try {
    await api.controlTask(taskId, action);
    toast(LABEL[action] || '已执行', 'ok');
    bus.emit(EVT.taskChanged, taskId);
    if (onDone) await onDone();
  } catch (err) {
    toast(errText(err, '操作失败'), 'error');
  }
}

/** 外发确认 → 授权 → 发起检索。整条链必须在用户勾选后才推进。 */
export function runAnalysesFlow({ taskId, engines, enabledFrames, onDone }) {
  return consentModal({
    task: { frames_done: enabledFrames },
    engines,
    onConfirm: async (scope) => {
      try {
        await api.confirmTask(taskId, scope);
        const res = await api.runAnalyses({
          task_id: taskId,
          providers: engines.filter((e) => e.enabled).map((e) => e.id),
          options: { allow_bridge: scope.bridge },
          consent_ack: true,
        });
        toast(`已提交 ${res.analyses?.length || 0} 个检索作业`, 'ok');
        bus.emit(EVT.taskChanged, taskId);
        if (onDone) await onDone();
      } catch (err) {
        toast(errText(err, '发起检索失败'), 'error');
      }
    },
  });
}

/** 手动检索入口列表：manual 态的平等出口（信息态，不是错误态）。 */
export function openManualModal(analyses) {
  const manual = analyses.filter((a) => a.status === 'manual');
  const ui = modal({
    title: '手动检索入口',
    sub: '这些帧 × 引擎组合没走通自动链路，改为由你把帧贴到引擎上传页。',
    iconName: 'hand',
    wide: true,
    body: manual.length
      ? manual.map((a) => h('div', { class: 'panel panel--pad', style: { padding: 'var(--space-3)' } },
          h('div', { class: 'row row--tight' }, icon('frame', 14, 'muted'), h('strong', { text: `第 ${a.frame_seq ?? '?'} 帧 · ${engineLabel(a.provider)}` })),
          h('p', { class: 'field__hint', text: a.error_message || errorText(a.error_code) }),
          manualActions(a)))
      : h('p', { class: 'muted', text: '当前没有待手动的组合。' }),
    actions: [h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => ui.close() }, '知道了')],
  });
  return ui;
}
