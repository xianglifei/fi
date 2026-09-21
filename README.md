# fi

基于 [dsh](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek Harness）内置 Web 界面的 Electron 桌面套壳。目标：先用最小契约把 `dsh --profile web` 完整装进原生窗口，后续在这个壳上持续二开。

## 使用

```bash
pnpm install
pnpm dev        # tsup watch + Electron
```

要求本机已全局安装 `@deepseek-ai/dsh`（`/opt/homebrew/bin/dsh`）。首次运行会自动 spawn dsh web 服务并打开窗口，认证 cookie 存在独立的 `persist:fi` 分区里，不影响浏览器里的登录。

环境变量（都是可选）：

- `FI_DSH_BIN` — 指定 dsh 可执行文件路径（默认按 PATH → homebrew → /usr/local 顺序找）
- `FI_DSH_URL` — 不 spawn，直接连接一个已在运行的 `dsh --profile web`（值带上 `?token=...`）

版本历史见 [CHANGELOG.md](CHANGELOG.md)；发版规则见 [AGENTS.md](AGENTS.md)。

## 工作原理

只依赖 dsh 的一条最小契约：**spawn → stdout 里的登录 URL → loadURL**。

```
Electron main
 ├─ 首次: dsh --profile fi --from-default-profile web   (从内置模板初始化专属 profile)
 ├─ 之后: dsh --profile fi --port 0 --no-open            (headless, 随机端口)
 ├─ 解析 stdout: "dsh web: http://127.0.0.1:<port>/?token=..."
 ├─ BrowserWindow.loadURL(url)  ← 首次加载 token 换 30 天 HttpOnly cookie
 └─ 生命周期: 崩溃重启(指数退避) / 退出 SIGTERM→SIGKILL 回收 / 单实例
```

**独立 profile**：fi 用自己的 `~/.dsh/profiles/fi`（内置 web 模板初始化，只有 `dsh-base + dsh-web-app` 两个基础 bundle），你在浏览器版 `dsh web` profile 里装的插件（如 peak-hours、whale-widget）不会进 fi；反过来想给 fi 单独装插件，执行 `dsh plugin --profile fi add <package>`。会话历史、设置、API 凭据在 `~/.dsh` 家目录层共享，不受 profile 影响。

**侧栏改版插件（`dsh-plugin/`）**：fi 的侧栏 UI（新建任务/搜索/定时任务/插件中心按钮列 + 项目模式入口）由随应用携带的 dsh 插件 `fi-sidebar` 实现，启动时自动 `dsh plugin --profile fi add link:` 进 profile（幂等；失败则退回 dsh 原生侧栏）。实现要点：

- 服务端半层启动时确保隐藏的 **default 工作区** 存在（`~/.dsh/workspace-default`，展示标题 `default`）。「新建任务」固定在这个工作区里新建会话；侧栏默认列表（普通模式）只展示它的会话（单列表、按最近更新倒序，可见性规则与 dsh 一致：排除子代理/已归档行，blank 行只保留当前那条）。用户不需要感知工作区概念。
- 客户端半层是手写的 dsh 客户端模块（`lib/client.js`，无构建步骤），以 `priority: -1` 影子接管 `sidebar.workspaces` 槽位（single 槽位取 priority 最低的注册者），并复用宿主的 `uiWorkspace` 服务（`startSession(workspaceId)` / `openSession(id)`）与 `useSessions` / `useWorkspaces` 等全局 hook；旧「新会话」按钮用 CSS 隐藏（选择器只匹配类名尾段 `_newSession`，容忍哈希变化）。
- 图标：fi 自有 UI（按钮列、项目模式入口、文件浏览器、右键菜单、搜索弹窗）全量使用内联的 Lucide 线稿——官方 path 数据进 `LUCIDE_INNER` 表（ISC 协议，无运行时依赖），`icon()` 优先查该表、未命中回落 dsh primitives；与 dsh 自身界面的 fill 风格图标刻意区分。
- 项目模式入口：logo 行没有对外 slot，客户端往 dsh 原生 logo 行注入容器节点，经 React portal 渲染文件夹图标按钮（收起按钮左侧，收起态隐藏；MutationObserver 防 React 重渲染挤掉外来节点）。点击进入项目模式（图标切换为打开状态），logo 行以下整体切换为 Finder 式文件浏览器，再点恢复普通模式。
- 项目文件浏览器：逐层进入（非树形展开），层级栈既是导航状态也是路径条（点面包屑跳转、返回上一级、手动刷新）。数据走 fi 自带的只读 Electron 文件桥（preload `window.fi.fs` → 主进程 `fs.promises.readdir(withFileTypes)`：符号链接按目标归类、断链灰显不可点，目录优先 + 自然排序，单层上限 1000 条并报 truncated）。单击文件用系统默认程序打开；右键菜单（复制路径 / 在 Finder 中显示 / 打开）走 `shell.*` 与剪贴板 IPC。浏览位置记在客户端模块级变量里：本次运行内退出项目模式再进入保持原地，重启复位。隐藏项（点前缀条目）名字与图标置灰；路径条上的「.*」按钮切换隐藏项显隐，默认不展示，选择持久在 localStorage（`fi.sidebar.showHidden`，跨重启，与只记本次运行的位置记忆不同）。浏览器直接打开 dsh 网页时无文件桥，项目模式显示提示行。
- 「在文件夹里新建任务」（文件夹行尾的气泡加号图标，Lucide `message-circle-plus`，对齐 ZCode 的新建任务图标；项目模式的核心）：客户端 `workspaces.create({ path })`（dsh `workspaceController` 远程，幂等，同一目录复用同一条工作区登记并立即合入客户端投影），随后 `uiWorkspace.startSession(workspaceId)`——复用该工作区里未发送过消息的 blank 会话，否则新建并在右侧打开。会话按 cwd 自动归入对应项目工作区，不进普通模式的 default 任务清单。右键复制路径成功不做提示（对齐系统惯例），失败提示仅保留给打开/新建动作。
- 「搜索」：点击按钮或按 ⌘K（Windows/Linux 为 Ctrl+K）唤起居中搜索弹窗（ZCode Command Center 的会话版：全屏模糊遮罩 + 顶部圆角面板，portal 到 body）。空查询列最近任务；输入后 250ms 防抖本地标题/工作区名匹配 + dsh 内建消息内容搜索（cordis `sessions` 服务，SQLite FTS，上限 20 条，`hasMore` 提示细化关键词）合并展示，↑/↓ 循环选择、Enter 打开、Esc/点遮罩关闭，标题命中加亮；搜索覆盖全部工作区（含项目模式文件夹），default 工作区的行不重复展示工作区名。「定时任务」「插件中心」仍为占位。普通/项目模式的选择记在 localStorage（`fi.sidebar.mode`）。
- 会话全文搜索索引：dsh 出厂 web 模板把 `session-query-sqlite` 配成 `openAt: never`（搜索 opt-in），fi 在插件补丁（`dsh-plugin/cordis.patch.yml`）里按同 id 覆盖为 `openAt: startup` + 落盘 `~/.dsh/session-query.db`，内容搜索才可用；后端不可用时弹窗自动降级为仅标题匹配并提示。

- **外链**：window.open 和主框架跳转里的外部 http(s) 一律走系统浏览器；dsh 同源弹窗（如附件预览）开小窗口共享会话。
- **流式中关窗确认**：preload 监听页面上停止按钮的 aria-label（“停止生成”/“Stop generating”，来自 dsh-client-ui-conversation 的 `input.stop`），流式期间关窗/退出会弹确认。dsh 改版或换语言导致标记失配时静默降级为直接关。
- **dsh 进程被外部杀掉**：窗口切到内建状态页，自动重启后无缝恢复界面。

## 路线图（二开层次，由浅入深）

1. **壳层原生**（当前）：托盘/菜单栏常驻、dock 徽标、通知、自动更新、打包 dmg（electron-builder）
2. **页面注入**（已启用）：侧栏改版走「dsh 插件 + 客户端模块」的正装路线（slot priority 影子替换、宿主服务复用）；fi preload 目前只做流式忙碌检测，后续 DOM 增强与快捷指令优先考虑插件层
3. **协议层**：壳直连 `/api/remote.mux`（会话事件、审批流），做壳自己的原生 UI
4. **kernel 层**：长期方向——像 fx-tui 一样以 Cordis bundle 挂进 dsh 内核（fx-gui-host），GUI 与 TUI 共享同一内核

参考：dsh 官方已保留 `desktop` profile 名给未来的 Electron 应用（其预设架构是 file:// 加载 dist + IPC 桥）；fi 目前刻意不复制那条重路线，HTTP 表面契约更小、升级更稳。

## 已知限制

- dsh 的握手只有 stdout 里一行 URL，无 `--print-url` 之类的机器接口；dsh 升级若改这行格式需要同步 `URL_LINE_RE`（src/main/dsh-process.ts）
- dev 模式下 macOS 菜单栏应用名显示为 "Electron"（来自 dev bundle 的 Info.plist），打包后即为 fi
- 忙碌检测只认中文/英文停止按钮文案，其他界面语言降级为不拦截关窗
- 侧栏插件依赖 dsh 的 slot/hook 面（`sidebar.workspaces` 槽位、`uiWorkspace` 服务、根 hooks）：dsh 大版本改动这些内部契约时，插件会静默失效并退回原生侧栏；旧「新会话」按钮的隐藏选择器匹配 CSS Modules 类名尾段，同样有随版本失效的可能
- 首次启动（或插件未装时）会多跑一步 profile 初始化 + 插件 link，启动略慢属正常
- 普通模式会话的输入框下方会显示 default 工作区名（来自 dsh 原生 composer 的工作区选择器），本期未处理
