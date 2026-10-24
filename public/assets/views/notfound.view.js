// notfound.view.js — 未匹配路由的 404 态。
import { h, icon } from '../dom.js';

export default {
  render(root, ctx) {
    root.appendChild(h('div', { class: 'panel panel--pad', style: { marginTop: 'var(--space-6)' } },
      h('div', { class: 'empty' },
        icon('search-x', 44, 'empty__icon'),
        h('p', { class: 'empty__title', text: '这个地址没有对应页面' }),
        h('p', { class: 'empty__desc', text: '可能是任务已被删除，或链接拼写有误。溯源工作台在左侧导航第一项，结果总览可以按任务反查。' }),
        h('div', { class: 'empty__actions' },
          h('a', { class: 'btn btn--primary', href: '/' }, icon('upload', 16), '回到溯源工作台'),
          h('a', { class: 'btn btn--secondary', href: '/results' }, icon('layers', 16), '查看结果总览')))));
    void ctx;
  },
};
