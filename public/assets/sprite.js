// sprite.js — 内联图标 sprite（54 个 symbol，全项目唯一图标事实来源）。
// 图标清单来源 docs/UIUX.md §14 + §19；由 dom.js 在模块求值期注入 document，保证首帧即有图标。
// 独立于 index.html 存放，使 HTML 外壳保持精简。
export const SPRITE = `
<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" class="sprite-host" aria-hidden="true" focusable="false">
    <symbol id="rvs-icon-upload" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M17 8l-5-5-5 5" />
      <path d="M12 3v12" />
    </symbol>
    <symbol id="rvs-icon-file-video" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M10.5 11l5 3-5 3v-6z" />
    </symbol>
    <symbol id="rvs-icon-film" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 4h18v16H3z" />
      <path d="M7 4v16" />
      <path d="M17 4v16" />
      <path d="M3 8h4" />
      <path d="M3 16h4" />
      <path d="M17 8h4" />
      <path d="M17 16h4" />
    </symbol>
    <symbol id="rvs-icon-frame" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 3h18v18H3z" />
      <path d="M3 9h18" />
      <path d="M3 15h18" />
      <path d="M9 3v18" />
      <path d="M15 3v18" />
    </symbol>
    <symbol id="rvs-icon-folder-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 19V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M3 19l2.5-6h15L18 19" />
    </symbol>
    <symbol id="rvs-icon-hard-drive" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M22 12H2" />
      <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
      <path d="M6 16h.01" />
      <path d="M10 16h.01" />
    </symbol>
    <symbol id="rvs-icon-search-image" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M3 12l2.5-2.5a1.5 1.5 0 0 1 2 0L11 13" />
      <path d="M9.5 6.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0" />
      <path d="M14 9a5 5 0 1 0 0 10 5 5 0 0 0 0-10" />
      <path d="M17.5 17.5L21 21" />
    </symbol>
    <symbol id="rvs-icon-search" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16" />
      <path d="M21 21l-4.35-4.35" />
    </symbol>
    <symbol id="rvs-icon-layers" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 2L2 7l10 5 10-5-10-5z" />
      <path d="M2 17l10 5 10-5" />
      <path d="M2 12l10 5 10-5" />
    </symbol>
    <symbol id="rvs-icon-compare" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 2v20" />
      <path d="M3 6h7v12H3z" />
      <path d="M14 6h7v12h-7z" />
    </symbol>
    <symbol id="rvs-icon-target" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20" />
      <path d="M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12" />
      <path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4" />
    </symbol>
    <symbol id="rvs-icon-hash" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 9h16" />
      <path d="M4 15h16" />
      <path d="M10 3L8 21" />
      <path d="M16 3l-2 18" />
    </symbol>
    <symbol id="rvs-icon-globe" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </symbol>
    <symbol id="rvs-icon-external-link" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6" />
      <path d="M10 14L21 3" />
    </symbol>
    <symbol id="rvs-icon-image-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M8.5 8.5a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0" />
      <path d="M21 15l-5-5L5 21" />
      <path d="M2 2l20 20" />
      <path d="M21 15v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h13" />
    </symbol>
    <symbol id="rvs-icon-grid" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 3h7v7H3z" />
      <path d="M14 3h7v7h-7z" />
      <path d="M14 14h7v7h-7z" />
      <path d="M3 14h7v7H3z" />
    </symbol>
    <symbol id="rvs-icon-list" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M8 6h13" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <path d="M3 6h1" />
      <path d="M3 12h1" />
      <path d="M3 18h1" />
    </symbol>
    <symbol id="rvs-icon-filter" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
    </symbol>
    <symbol id="rvs-icon-sort" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M7 4v16" />
      <path d="M7 20l-3-3" />
      <path d="M7 20l3-3" />
      <path d="M17 20V4" />
      <path d="M17 4l-3 3" />
      <path d="M17 4l3 3" />
    </symbol>
    <symbol id="rvs-icon-download" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </symbol>
    <symbol id="rvs-icon-copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2z" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </symbol>
    <symbol id="rvs-icon-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6" />
    </symbol>
    <symbol id="rvs-icon-refresh" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 3v6h-6" />
      <path d="M3 12a9 9 0 0 1 15-6.7L21 9" />
      <path d="M3 21v-6h6" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 15" />
    </symbol>
    <symbol id="rvs-icon-trash" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </symbol>
    <symbol id="rvs-icon-plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </symbol>
    <symbol id="rvs-icon-x" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M18 6L6 18" />
      <path d="M6 6l12 12" />
    </symbol>
    <symbol id="rvs-icon-chevron-down" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M6 9l6 6 6-6" />
    </symbol>
    <symbol id="rvs-icon-chevron-right" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M9 18l6-6-6-6" />
    </symbol>
    <symbol id="rvs-icon-play" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M7 4l12 8-12 8z" />
    </symbol>
    <symbol id="rvs-icon-pause" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M7 4h3v16H7z" />
      <path d="M14 4h3v16h-3z" />
    </symbol>
    <symbol id="rvs-icon-stop" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M6 6h12v12H6z" />
    </symbol>
    <symbol id="rvs-icon-loader" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 2v4" />
      <path d="M12 18v4" />
      <path d="M4.93 4.93l2.83 2.83" />
      <path d="M16.24 16.24l2.83 2.83" />
      <path d="M2 12h4" />
      <path d="M18 12h4" />
      <path d="M4.93 19.07l2.83-2.83" />
      <path d="M16.24 7.76l2.83-2.83" />
    </symbol>
    <symbol id="rvs-icon-check-circle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <path d="M22 4L12 14.01l-3-3" />
    </symbol>
    <symbol id="rvs-icon-alert-triangle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </symbol>
    <symbol id="rvs-icon-x-circle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20" />
      <path d="M15 9l-6 6" />
      <path d="M9 9l6 6" />
    </symbol>
    <symbol id="rvs-icon-clock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20" />
      <path d="M12 7v5l3.5 2" />
    </symbol>
    <symbol id="rvs-icon-zap" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z" />
    </symbol>
    <symbol id="rvs-icon-wifi-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M2 2l20 20" />
      <path d="M16.5 9.5A6 6 0 0 1 19 12.5" />
      <path d="M8.5 12.5a6 6 0 0 1 3.2-1.9" />
      <path d="M5 12.5a11 11 0 0 1 3.5-2.4" />
      <path d="M2 8.8A15 15 0 0 1 8 5.4" />
      <path d="M12 20h.01" />
      <path d="M22 8.8a15 15 0 0 0-7-3" />
    </symbol>
    <symbol id="rvs-icon-info" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </symbol>
    <symbol id="rvs-icon-settings" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 21v-7" />
      <path d="M4 10V3" />
      <path d="M12 21v-9" />
      <path d="M12 8V3" />
      <path d="M20 21v-5" />
      <path d="M20 12V3" />
      <path d="M1 14h6" />
      <path d="M9 8h6" />
      <path d="M17 16h6" />
    </symbol>
    <symbol id="rvs-icon-server" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 4h16v6H4z" />
      <path d="M4 14h16v6H4z" />
      <path d="M8 7h.01" />
      <path d="M8 17h.01" />
    </symbol>
    <symbol id="rvs-icon-database" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 8c4.97 0 9-1.34 9-3s-4.03-3-9-3-9 1.34-9 3 4.03 3 9 3z" />
      <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
      <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" />
    </symbol>
    <symbol id="rvs-icon-shield" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 12l2 2 4-4" />
    </symbol>
    <symbol id="rvs-icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10" />
      <path d="M12 1v2" />
      <path d="M12 21v2" />
      <path d="M4.22 4.22l1.42 1.42" />
      <path d="M18.36 18.36l1.42 1.42" />
      <path d="M1 12h2" />
      <path d="M21 12h2" />
      <path d="M4.22 19.78l1.42-1.42" />
      <path d="M18.36 5.64l1.42-1.42" />
    </symbol>
    <symbol id="rvs-icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </symbol>
    <symbol id="rvs-icon-send" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M22 2L11 13" />
      <path d="M22 2l-7 20-4-9-9-4 20-7z" />
    </symbol>
    <symbol id="rvs-icon-search-x" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16" />
      <path d="M21 21l-4.35-4.35" />
      <path d="M9 9l4 4" />
      <path d="M13 9l-4 4" />
    </symbol>
    <symbol id="rvs-icon-shield-alert" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </symbol>
    <symbol id="rvs-icon-key" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M10 14a5 5 0 1 0 0-10 5 5 0 0 0 0 10" />
      <path d="M14 10l7-7" />
      <path d="M19 5l2 2" />
      <path d="M17 7l2 2" />
    </symbol>
    <symbol id="rvs-icon-ban" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20" />
      <path d="M4.93 4.93l14.14 14.14" />
    </symbol>
    <symbol id="rvs-icon-hand" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M18 11V6a2 2 0 0 0-4 0" />
      <path d="M14 10V4a2 2 0 0 0-4 0v2" />
      <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 .9-3.35V6a2 2 0 0 0-4 0v6" />
    </symbol>
    <symbol id="rvs-icon-cloud-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M2 2l20 20" />
      <path d="M17.5 19H9a7 7 0 0 1-1.8-13.77" />
      <path d="M10.8 5.05A7 7 0 0 1 17.5 12c0 .6-.08 1.18-.23 1.73" />
    </symbol>
    <symbol id="rvs-icon-credit-card" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M2 5h20v14H2z" />
      <path d="M2 10h20" />
      <path d="M6 15h4" />
    </symbol>
    <symbol id="rvs-icon-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M5 11h14v10H5z" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      <path d="M12 15v2" />
    </symbol>
</svg>
`;
