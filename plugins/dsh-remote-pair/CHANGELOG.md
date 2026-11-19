# Changelog

## 0.2.0

### 新增

- 长期访问链接：一条带 key 的固定链接（二维码同源），任何浏览器打开都能登录，直到主动换新；key 存在 `$DSH_HOME/remote-pair/access.json`（600）。
- 「换一个新链接」：一键轮换，旧链接立刻失效。
- PWA 支持：用 `webServer.tapIndex` 补上 iOS 需要的 `theme-color`、`apple-mobile-web-app-capable`、状态栏样式等标签，配合 DSH 自带 manifest 可「添加到主屏幕」。
- 面板增加安装引导与「复制链接」。

### 调整

- 二维码内容从「一次性配对码」改为「长期访问链接」，扫一次即可长期使用。
- 一次性配对码（`/pair`）保留，用于临时把新设备带进来。
- 发布版 `cordis.patch.yml` 的 `publicBaseUrl` 改为占位符，真实入口由使用者在 profile 里配置。

### 文档

- README 增加「你需要一台服务器」前置说明与自建 frp 的完整部署手册（DNS、证书、frps、nginx、frpc、DSH 配置）。
- 效果图补上手机端装好后的截图。

## 0.1.0

- 首个可用版本：配对码、二维码、手机侧登录入口、桌面侧只读接口（Host 必须是 loopback）。

## [0.2.0] - 2026-11-19

- 手机访问改为长期链接（扫码一次长期有效），支持添加到主屏幕，新增服务器部署手册
