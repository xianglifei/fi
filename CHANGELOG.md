# Changelog

本项目的所有显著变更记录在此文件。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本（SemVer）。

> 维护规则：每次向 GitHub 推送新版本之前，必须先在这里补上对应条目；日常变更先写入 Unreleased，发版时定版。

## [Unreleased]

## [0.3.0] - 2026-09-22

### Added

- 侧栏「搜索」正式可用：点击搜索按钮或按 ⌘K（Windows/Linux 为 Ctrl+K）弹出居中搜索框，可按任务标题和消息内容检索自己的全部任务（含项目模式各文件夹里的会话）；↑/↓ 选择、回车打开、Esc 关闭，无关键词时展示最近任务。消息内容搜索由 dsh 内建引擎提供（仅搜有工作目录的可见会话），结果较多时会提示换更具体的关键词。
- fi 现在随插件打开 dsh 的会话全文搜索索引（dsh 出厂 web 模板默认关闭）：首次启动会为历史会话建立一次索引（索引库在 `~/.dsh/session-query.db`），之后增量更新。

## [0.2.0] - 2026-09-21

### Added

- 侧栏改版：顶部由单个「新会话」升级为四个入口——「新建任务」（即原「新会话」，一律在内置默认工作区中新建）、「搜索」「定时任务」「插件中心」（后三个为入口占位，功能后续版本开放）。侧栏默认展示任务列表（单列表、按「最近更新」倒序），列表只包含内置默认工作区的会话；默认工作区由 fi 预先创建并对用户不可见（磁盘位置 `~/.dsh/workspace-default`），用户无需理解工作区概念。
- 侧栏右上角（「收起侧边栏」按钮左侧）新增项目模式入口（文件夹图标，激活时变为打开状态）：点击进入项目模式，logo 行以下（四个入口按钮与任务列表）整体切换为 Finder 式文件浏览器；再次点击恢复普通模式。
- 项目模式的文件浏览器从用户主目录起逐层浏览电脑文件夹：单击文件夹进入、单击文件用系统默认程序打开；路径条可点击任意上级跳转，另有返回上一级与手动刷新。浏览位置在本次运行内记忆——退出项目模式再进入保持原地，重启应用后回到主目录。
- 隐藏文件/文件夹（点前缀条目）的名字与图标置灰显示，与普通条目形成区分；路径条上的「.*」按钮切换隐藏项的显隐——默认不展示隐藏项，切换后的选择会被记住（重启后仍生效）。
- 文件夹行尾的「新任务」气泡图标（对齐 ZCode 的新建任务图标，dsh `IconNewChat`）是项目模式的核心动作：在该文件夹里新建任务。文件夹自动登记为 dsh 工作区（同一文件夹复用同一条登记），新会话以该文件夹为工作目录并在右侧打开；这类会话归入各自的项目工作区，不会混进普通模式的任务清单。
- 右键任意条目可复制路径、在 Finder 中显示、用系统默认程序打开。文件浏览能力仅 fi 桌面版提供（用浏览器直接打开 dsh 网页时，项目模式显示相应提示）。
- 上述改版由随应用携带的 dsh 插件 `fi-sidebar`（`dsh-plugin/`）实现：fi 启动时自动把它 link 进 fi profile 并激活；插件缺失或安装失败时自动退回 dsh 原生侧栏，不影响其他功能。

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

[Unreleased]: https://github.com/xianglifei/fi/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/xianglifei/fi/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/xianglifei/fi/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/xianglifei/fi/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/xianglifei/fi/releases/tag/v0.1.0
