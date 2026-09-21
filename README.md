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

- **外链**：window.open 和主框架跳转里的外部 http(s) 一律走系统浏览器；dsh 同源弹窗（如附件预览）开小窗口共享会话。
- **流式中关窗确认**：preload 监听页面上停止按钮的 aria-label（“停止生成”/“Stop generating”，来自 dsh-client-ui-conversation 的 `input.stop`），流式期间关窗/退出会弹确认。dsh 改版或换语言导致标记失配时静默降级为直接关。
- **dsh 进程被外部杀掉**：窗口切到内建状态页，自动重启后无缝恢复界面。

## 路线图（二开层次，由浅入深）

1. **壳层原生**（当前）：托盘/菜单栏常驻、dock 徽标、通知、自动更新、打包 dmg（electron-builder）
2. **页面注入**：preload 里做 DOM 增强与快捷指令；或走 dsh 插件机制（自定义 profile + `dsh plugin --profile web add`，fx-dsh/dsh-peak-hours 已验证此层）
3. **协议层**：壳直连 `/api/remote.mux`（会话事件、审批流），做壳自己的原生 UI
4. **kernel 层**：长期方向——像 fx-tui 一样以 Cordis bundle 挂进 dsh 内核（fx-gui-host），GUI 与 TUI 共享同一内核

参考：dsh 官方已保留 `desktop` profile 名给未来的 Electron 应用（其预设架构是 file:// 加载 dist + IPC 桥）；fi 目前刻意不复制那条重路线，HTTP 表面契约更小、升级更稳。

## 已知限制

- dsh 的握手只有 stdout 里一行 URL，无 `--print-url` 之类的机器接口；dsh 升级若改这行格式需要同步 `URL_LINE_RE`（src/main/dsh-process.ts）
- dev 模式下 macOS 菜单栏应用名显示为 "Electron"（来自 dev bundle 的 Info.plist），打包后即为 fi
- 忙碌检测只认中文/英文停止按钮文案，其他界面语言降级为不拦截关窗
