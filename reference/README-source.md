# Reverse Video Search — local version

这是一个完全本地的静态版本，复刻目标页面的主要工作流：

- 在浏览器中提取视频关键帧，支持 MP4 / MOV / WEBM
- 直接上传图片进行单帧反向搜索
- 帧图预览、下载、保存搜索历史
- 本地 WAV 音轨导出
- 为每一帧提供 Google Lens、Bing、Yandex、TinEye 入口
- 抽帧完成后可通过 Chrome 扩展自动上传关键帧到 Google Lens
- 深色模式与响应式布局

## 运行

直接双击 `dist/index.html` 即可打开。若浏览器限制了本地文件的部分媒体能力，也可以在此目录启动任意静态文件服务器后访问 `dist/`。

本地版不会伪造第三方搜索结果，也不会绕过原站的付费服务；外部搜索按钮会把当前帧交给对应搜索引擎处理，是否上传图片由第三方网站决定。

Google Lens 的 `uploadbyurl` 接口不接受浏览器本地的 `data:` 图片地址，因此本地页面不会伪造命中数或继续打开空结果页。页面会提示使用 Google 的“上传文件”入口；若要完全自动上传，使用浏览器扩展桥接器。

## 自动上传桥接器

推荐使用 `extension/` 中的 Chrome 扩展。它通过 Chrome 的文件上传控件逐帧提交 Google Lens，并把上传进度回传到本地页面。安装步骤见 [extension/README.md](extension/README.md)。

扩展方式比独立本机脚本更适合这个页面：不需要启动调试端口，能复用当前 Chrome 会话，并且权限范围可以限制在本地页面和 Google 图片页面。Google 返回的结果仍在 Google 标签页中显示，本地页面会同步显示读取到的候选链接和命中条数。

## 原站流程调研

原站并不是把本地图片直接拼到 Google 的 `uploadbyurl` 地址中。它先把抽取出的帧以 `data:` 图片数据上传到自己的 `/api/file-upload`，得到 `video_id`，再调用 `/api/search/run-analyses`，提交 `video_id`、帧索引和 `serpapi_reverse`、`yandex_reverse`、`bing_reverse` 等 provider。结果由服务器端搜索服务返回，页面只负责展示结果；这些接口需要原站登录令牌和积分。

因此本地版不能在没有账号、积分或第三方搜索 API 密钥的情况下直接复制原站的命中结果。当前扩展桥接器采用 Google Lens 的真实 multipart 上传流程，优先提交 `https://lens.google.com/v3/upload`，等待结果页后读取普通外链和 Google `/url`、`/goto` 结果卡片；只有浏览器拒绝表单注入时才退回文件控件上传。命中条数来自 Google 页面上实际读取到的候选链接，读取不到时会显示 0。
