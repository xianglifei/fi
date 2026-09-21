# Changelog

本项目的所有显著变更记录在此文件。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本（SemVer）。

> 维护规则：每次向 GitHub 推送新版本之前，必须先在这里补上对应条目；日常变更先写入 Unreleased，发版时定版。

## [Unreleased]

## [0.1.1] - 2026-09-21

### Changed

- 壳改用专属 dsh profile：首次启动经 `--from-default-profile web` 从内置模板初始化 `~/.dsh/profiles/fi`（仅 `dsh-base + dsh-web-app`），浏览器版 web profile 里用户自行安装的插件（dsh-peak-hours、dsh-whale-widget）不再进入桌面应用；会话、设置、API 凭据仍在 `~/.dsh` 家目录层共享。给 fi 单独装插件：`dsh plugin --profile fi add <package>`。

## [0.1.0] - 2026-09-21

### Added

- Electron 套壳：spawn `dsh --profile web --port 0 --no-open`，从 stdout 解析带 token 的登录 URL 并载入 BrowserWindow（独立 `persist:fi` 会话分区，30 天认证 cookie）。
- dsh 进程崩溃自动重启（指数退避，重启后窗口无缝切到新端口）。
- 退出时 SIGTERM → 超时 SIGKILL 干净回收 dsh 子进程，无孤儿。
- 外部链接走系统浏览器；dsh 同源弹窗开小窗口共享会话。
- 流式输出中的关窗确认（preload 监听停止按钮 aria-label「停止生成/Stop generating」，标记失配时静默降级为直接关）。
- 单实例锁、macOS 标准角色菜单（复制粘贴/缩放/刷新）。

[Unreleased]: https://github.com/xianglifei/fi/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/xianglifei/fi/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/xianglifei/fi/releases/tag/v0.1.0
