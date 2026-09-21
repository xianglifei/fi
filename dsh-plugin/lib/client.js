window.__ModuleLoader__.load({
	id: "fi-sidebar",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// 手写为 dsh 客户端模块格式（与 dsh-client-ui-* bundle 同构），无构建步骤。
		// react / react-dom / primitives 是壳内置静态模块，require 即用。
		const react = require("react");
		const jsx = require("react/jsx-runtime");
		const reactDom = require("react-dom");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		//#region constants
		const NS = "fiSidebar";
		/** 普通模式背后的隐藏工作区标题；服务端半层负责保证它存在。 */
		const DEFAULT_WORKSPACE_TITLE = "default";
		const MODE_STORAGE_KEY = "fi.sidebar.mode";

		const ICONS = {
			newTask: "IconPlusOutline16",
			search: "IconSearchOutline16",
			schedule: "IconAlarmClockOutline16",
			plugins: "IconCordisPluginOutline14",
			projectOff: "IconFolderClose16",
			projectOn: "IconFolderOpen16",
		};

		function icon(name, size) {
			const Icon = primitives[name];
			return Icon === undefined ? null : jsx.jsx(Icon, { size: size ?? 16 });
		}
		//#endregion

		//#region locales
		const zh = {
			"newTask": "新建任务",
			"search": "搜索",
			"schedule": "定时任务",
			"plugins": "插件中心",
			"mode.project": "项目模式",
			"section.tasks": "任务",
			"session.new": "新任务",
			"row.open.aria": "打开会话「{name}」",
			"row.newTaskHere": "在此文件夹新建任务",
			"empty.none": "暂无会话",
			"empty.loading": "正在加载…",
			"fb.back": "返回上一级",
			"fb.refresh": "刷新",
			"fb.toggleHidden": "显示或隐藏隐藏文件",
			"fb.loading": "正在加载…",
			"fb.emptyDir": "空文件夹",
			"fb.denied": "没有权限读取这个文件夹",
			"fb.notFound": "文件夹不存在或已被移动",
			"fb.notDirectory": "这个路径不是文件夹",
			"fb.errorOther": "读取失败：{msg}",
			"fb.truncated": "目录过大，仅显示前 {n} 项",
			"fb.desktopOnly": "文件浏览仅限 fi 桌面版使用",
			"fb.copyPath": "复制路径",
			"fb.reveal": "在 Finder 中显示",
			"fb.open": "打开",
			"fb.openFailed": "无法打开：{msg}",
			"fb.taskFailed": "新建任务失败：{msg}",
			"time.now": "刚刚",
			"time.minutes": "{n}分钟",
			"time.hours": "{n}小时",
			"time.days": "{n}天",
			"time.months": "{n}个月",
			"time.years": "{n}年",
		};
		const en = {
			"newTask": "New Task",
			"search": "Search",
			"schedule": "Scheduled",
			"plugins": "Plugins",
			"mode.project": "Projects",
			"section.tasks": "Tasks",
			"session.new": "New Task",
			"row.open.aria": "Open session \"{name}\"",
			"row.newTaskHere": "New task in this folder",
			"empty.none": "No sessions yet",
			"empty.loading": "Loading…",
			"fb.back": "Up one level",
			"fb.refresh": "Refresh",
			"fb.toggleHidden": "Show or hide hidden files",
			"fb.loading": "Loading…",
			"fb.emptyDir": "Empty folder",
			"fb.denied": "No permission to read this folder",
			"fb.notFound": "Folder not found or moved",
			"fb.notDirectory": "Not a folder",
			"fb.errorOther": "Failed to read: {msg}",
			"fb.truncated": "Large directory — showing first {n} entries",
			"fb.desktopOnly": "File browsing is available in the fi desktop app only",
			"fb.copyPath": "Copy Path",
			"fb.reveal": "Reveal in Finder",
			"fb.open": "Open",
			"fb.openFailed": "Cannot open: {msg}",
			"fb.taskFailed": "Failed to create task: {msg}",
			"time.now": "now",
			"time.minutes": "{n}m",
			"time.hours": "{n}h",
			"time.days": "{n}d",
			"time.months": "{n}mo",
			"time.years": "{n}y",
		};

		/** 词典键对应的参数：time.* 接 {n}。 */
		function format(template, params) {
			return template.replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? ""));
		}
		//#endregion

		//#region styles
		// 折叠成 56px rail 时本区域整体让位；旧的「新会话」按钮由 fi 按钮列取代。
		// 选择器只匹配类名尾段（CSS Modules 哈希前缀会随构建变化，语义段不变）。
		const css = `
button[class*="_newSession"] { display: none !important; }
.fi-region { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.fi-region--rail { display: none; }
.fi-actions { display: flex; flex-direction: column; flex: none; gap: 4px; margin: 2px 2px 10px; }
.fi-action { display: flex; align-items: center; justify-content: flex-start; gap: 7px;
  width: 100%; height: 36px; padding: 0 12px; border: none; border-radius: 10px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 13.5px; font-weight: 500; line-height: 20px;
  cursor: pointer; white-space: nowrap; }
.fi-region--rail .fi-action { justify-content: center; padding: 0; }
.fi-action:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.fi-action:focus-visible { outline: 2px solid var(--dsw-alias-label-primary); outline-offset: -2px; }
.fi-action--primary { height: 38px; border: 0.5px solid var(--dsw-alias-border-l3);
  background: var(--dsw-alias-button-elevated-fill, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-label-primary); }
.fi-action--primary:hover { background: var(--dsw-alias-button-floating-hover, var(--dsw-alias-interactive-bg-hover)); }
/* 项目模式入口：注入到 dsh 侧栏 logo 行（收起按钮左侧）的容器与按钮 */
.fi-ws-toggle-host { display: inline-flex; flex: none; }
.fi-ws-toggle { corner-shape: round; cursor: pointer; width: 28px; height: 28px;
  color: var(--dsw-alias-label-secondary); background: transparent; border: none;
  border-radius: 50%; flex: none; justify-content: center; align-items: center;
  padding: 0; display: inline-flex; }
.fi-ws-toggle:hover { background: var(--dsw-alias-interactive-bg-hover); }
.fi-ws-toggle:focus-visible { outline: 2px solid var(--dsw-alias-label-primary); outline-offset: -2px; }
.fi-ws-toggle[aria-pressed="true"] { color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-active); }
[class*="_collapsed"] .fi-ws-toggle-host { display: none; }
/* 分组标题行：复刻 dsh WorkspaceBrowser sectionHeader 的样式配方
   （高 36px、三级灰、line-height 20px、padding-left 4px），去掉右侧按钮 */
.fi-section { box-sizing: border-box; height: 36px; flex: none; align-items: center;
  margin: 2px 0 4px; padding-left: 4px; display: flex;
  color: var(--dsw-alias-label-tertiary); overflow: hidden; }
.fi-section-label { white-space: nowrap; min-width: 0; line-height: 20px; overflow: hidden; }
.fi-list { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 6px 16px 2px;
  scrollbar-width: thin; scrollbar-color: var(--dsh-scrollbar-thumb, transparent) transparent; }
.fi-row { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 34px;
  padding: 6px 8px; border: none; border-radius: 8px; background: transparent;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 22px;
  text-align: left; cursor: pointer; }
.fi-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.fi-row:focus-visible { outline: 2px solid var(--dsw-alias-label-primary); outline-offset: -2px; }
.fi-row[data-selected="true"] { background: var(--dsw-alias-interactive-bg-active); font-weight: 500; }
.fi-row-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fi-row-time { flex: none; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.fi-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; }
.fi-dot--running { background: var(--dsw-alias-state-success-primary); }
.fi-dot--pending { background: var(--dsw-alias-state-business-primary); }
.fi-empty { color: var(--dsw-alias-label-tertiary); padding: 16px 10px; font-size: 13px; }
.fi-loading { color: var(--dsw-alias-label-tertiary); padding: 16px 10px; font-size: 13px; }
/* 项目模式文件浏览器：路径条 + 当前目录列表（逐层进入，非树形展开） */
.fi-fb { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.fi-fb-bar { flex: none; display: flex; align-items: center; gap: 1px; padding: 0 2px 6px; }
.fi-fb-nav { flex: none; width: 24px; height: 24px; border: none; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; padding: 0; }
.fi-fb-nav:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.fi-fb-nav:disabled { opacity: 0.4; cursor: default; background: transparent; color: var(--dsw-alias-label-secondary); }
.fi-fb-nav:focus-visible { outline: 2px solid var(--dsw-alias-label-primary); outline-offset: -2px; }
.fi-fb-nav[aria-pressed="true"] { color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-active); }
.fi-fb-nav-text { font-size: 11px; font-weight: 600; line-height: 1; letter-spacing: 0.2px; }
.fi-fb-crumbs { flex: 1; min-width: 0; display: flex; align-items: center; overflow-x: auto;
  scrollbar-width: none; white-space: nowrap; padding: 2px; }
.fi-fb-crumbs::-webkit-scrollbar { display: none; }
.fi-fb-crumb { flex: none; max-width: 140px; overflow: hidden; text-overflow: ellipsis;
  border: none; border-radius: 6px; padding: 2px 4px; background: transparent;
  color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 12.5px; line-height: 18px; cursor: pointer; }
.fi-fb-crumb:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.fi-fb-crumb[aria-current="true"] { color: var(--dsw-alias-label-primary); font-weight: 500; }
.fi-fb-sep { flex: none; color: var(--dsw-alias-label-tertiary); font-size: 11px; user-select: none; }
.fi-fb-list { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 6px 16px 2px;
  scrollbar-width: thin; scrollbar-color: var(--dsh-scrollbar-thumb, transparent) transparent; }
.fi-fb-row { display: flex; align-items: center; gap: 7px; width: 100%; min-height: 32px;
  padding: 5px 6px 5px 8px; border: none; border-radius: 8px; background: transparent;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 13.5px; line-height: 20px;
  text-align: left; cursor: pointer; }
.fi-fb-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.fi-fb-row:focus-visible { outline: 2px solid var(--dsw-alias-label-primary); outline-offset: -2px; }
.fi-fb-row--other, .fi-fb-row--other:hover { color: var(--dsw-alias-label-tertiary); cursor: default; background: transparent; }
/* 隐藏项（点前缀）整行置灰：名字与图标一起降到三级灰，悬浮背景保留 */
.fi-fb-row--hidden { color: var(--dsw-alias-label-tertiary); }
.fi-fb-row--hidden .fi-fb-row-icon { color: var(--dsw-alias-label-tertiary); }
.fi-fb-row-icon { flex: none; display: inline-flex; color: var(--dsw-alias-label-secondary); }
.fi-fb-row-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fi-fb-new { flex: none; width: 24px; height: 24px; border: none; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; padding: 0; }
.fi-fb-new:hover { background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-primary); }
.fi-fb-new:disabled { opacity: 0.5; cursor: default; }
.fi-fb-note { color: var(--dsw-alias-label-tertiary); padding: 14px 10px; font-size: 13px; }
.fi-fb-status { flex: none; color: var(--dsw-alias-state-danger-primary, #d33); padding: 0 10px 6px;
  font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fi-fb-menu { position: fixed; z-index: 1000; min-width: 176px; padding: 4px;
  background: var(--dsw-alias-bg-layer-1); border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 10px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16); }
.fi-fb-menu-item { display: flex; align-items: center; gap: 8px; width: 100%; height: 30px;
  padding: 0 10px; border: none; border-radius: 6px; background: transparent;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 18px;
  cursor: pointer; text-align: left; white-space: nowrap; }
.fi-fb-menu-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.fi-fb-menu-item:focus-visible { outline: 2px solid var(--dsw-alias-label-primary); outline-offset: -2px; }
`;
		const CSS_TAG_ID = "fi-sidebar/sidebar.css";
		if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${CSS_TAG_ID}"]`) === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "fi-sidebar";
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region data
		/**
		 * default 工作区的会话行，按最近更新逆序（同分按 id 稳定排序，规则对齐
		 * dsh WorkspaceBrowser 的 byRecency）。可见性与 dsh 一致：排除子代理行、
		 * 已归档行；blank 行只保留当前那条（未发送首条消息的新任务）。
		 */
		function deriveRows(sessions, workspaces) {
			if (sessions.phase !== "ready" || workspaces.phase !== "ready") return null;
			const ws = workspaces.items.find((w) => w.title === DEFAULT_WORKSPACE_TITLE);
			if (ws === undefined) return [];
			const archived = new Set(workspaces.archivedSessionIds);
			const rows = [];
			for (const id of ws.sessionIds) {
				const s = sessions.byId[id];
				if (s === undefined) continue;
				if (s.origin === "subagent" || archived.has(s.id)) continue;
				if (s.blank && s.id !== sessions.current) continue;
				rows.push(s);
			}
			rows.sort((a, b) => (b.updatedAt !== a.updatedAt ? b.updatedAt - a.updatedAt : (a.id < b.id ? -1 : 1)));
			return rows;
		}

		function relativeTime(timestamp, t) {
			const ms = Date.now() - timestamp;
			const minutes = Math.floor(ms / 60000);
			if (minutes < 1) return t("time.now");
			if (minutes < 60) return format(t("time.minutes"), { n: minutes });
			const hours = Math.floor(minutes / 60);
			if (hours < 24) return format(t("time.hours"), { n: hours });
			const days = Math.floor(hours / 24);
			if (days < 30) return format(t("time.days"), { n: days });
			const months = Math.floor(days / 30);
			if (months < 12) return format(t("time.months"), { n: months });
			return format(t("time.years"), { n: Math.floor(months / 12) });
		}
		//#endregion

		//#region components
		function ActionButton({ label, primary, icon: iconName, onClick }) {
			return jsx.jsx("button", {
				type: "button",
				className: primary ? "fi-action fi-action--primary" : "fi-action",
				"aria-label": label,
				onClick,
				children: [icon(iconName, primary ? 16 : 18), jsx.jsx("span", { children: label })],
			});
		}

		function SessionRow({ session, selected, pending, onOpen, t }) {
			const title = session.blank ? t("session.new") : String(session.displayTitle ?? "");
			return jsx.jsxs("button", {
				type: "button",
				className: "fi-row",
				"data-selected": selected ? "true" : undefined,
				"aria-label": format(t("row.open.aria"), { name: title }),
				onClick: () => onOpen(session.id),
				children: [
					pending
						? jsx.jsx("span", { className: "fi-dot fi-dot--pending", "aria-hidden": "true" })
						: session.running
							? jsx.jsx("span", { className: "fi-dot fi-dot--running", "aria-hidden": "true" })
							: null,
					jsx.jsx("span", { className: "fi-row-title", children: title }),
					session.blank ? null : jsx.jsx("span", { className: "fi-row-time", children: relativeTime(session.updatedAt, t) }),
				],
			});
		}

		/**
		 * 项目模式入口按钮：渲染进 dsh 侧栏 logo 行（收起按钮左侧）。
		 * 文件夹图标呼应侧栏的项目分组语义；激活（项目模式开启）时换打开的文件夹。
		 */
		function ProjectModeToggle({ active, onToggle, t }) {
			const Icon = primitives[active ? ICONS.projectOn : ICONS.projectOff];
			return jsx.jsx(primitives.Tooltip, {
				label: t("mode.project"),
				side: "bottom",
				delayMs: 500,
				children: jsx.jsx("button", {
					type: "button",
					className: "fi-ws-toggle",
					"aria-label": t("mode.project"),
					"aria-pressed": active ? "true" : "false",
					onClick: onToggle,
					children: Icon === undefined ? null : jsx.jsx(Icon, { size: 16 }),
				}),
			});
		}

		/**
		 * 把项目模式入口挂进 dsh 原生 logo 行。logo 行没有对外 slot，只能注入
		 * 宿主 DOM：在收起按钮前插入容器，经 React portal 渲染按钮（状态仍归
		 * FiSidebarRegion 管）。React 重渲染可能移除外来节点，观察器负责把同一
		 * 容器插回（portal 不需要重建）。
		 */
		function useLogoRowToggleHost() {
			const [host, setHost] = react.useState(null);
			const hostRef = react.useRef(null);
			react.useEffect(() => {
				const reconcile = () => {
					const row = document.querySelector('[class*="_logoRow"]');
					if (row === null) return;
					let node = hostRef.current;
					if (node === null || !node.isConnected) {
						node = row.querySelector(":scope > .fi-ws-toggle-host") ?? document.createElement("div");
						node.className = "fi-ws-toggle-host";
					}
					if (node.parentElement !== row) {
						const toggle = row.lastElementChild;
						if (toggle !== null && toggle !== node) row.insertBefore(node, toggle);
						else row.appendChild(node);
					}
					if (hostRef.current !== node) {
						hostRef.current = node;
						setHost(node);
					}
				};
				reconcile();
				const observer = new MutationObserver(reconcile);
				observer.observe(document.documentElement, { childList: true, subtree: true });
				return () => {
					observer.disconnect();
					hostRef.current = null;
					setHost(null);
				};
			}, []);
			return host;
		}

		/**
		 * fi 侧栏主体。以 priority -1 影子接管 dsh 的 sidebar.workspaces 槽位
		 * （single 槽位取 priority 最低的注册者，同 priority 才冲突）。
		 * 普通模式即默认视图（按钮列 + 任务列表）；项目模式入口在右上角 logo
		 * 行，开启后整个区域切换为文件浏览器（Finder 式逐层进入），再点恢复。
		 * useSessions / useWorkspaces / usePanelInfo / useSessionPendingInteraction
		 * 是槽位宿主通过 provideRoot 下发的全局 hook；t 绑定本注册的 fiSidebar 词典。
		 */
		function FiSidebarRegion({ wide, expandSidebar, startNewTask, startNewTaskIn, openSession, useSessions, useWorkspaces, usePanelInfo, useSessionPendingInteraction, t }) {
			const [mode, setMode] = react.useState(() => {
				try {
					return window.localStorage.getItem(MODE_STORAGE_KEY) === "project" ? "project" : "normal";
				} catch {
					return "normal";
				}
			});
			const switchMode = (next) => {
				setMode(next);
				try {
					window.localStorage.setItem(MODE_STORAGE_KEY, next);
				} catch { /* 存储不可用时仅退化为不记忆 */ }
			};
			const toggleHost = useLogoRowToggleHost();

			const sessions = useSessions((s) => s);
			const workspaces = useWorkspaces((s) => s);
			const panelActive = usePanelInfo((info) => info.activePanelId !== null);
			const pending = useSessionPendingInteraction((s) => s);

			const rows = react.useMemo(() => deriveRows(sessions, workspaces), [sessions, workspaces]);
			const currentId = panelActive ? undefined : sessions.current;

			if (!wide) {
				// 折叠 rail：只留搜索入口，点按展开侧栏（对齐 dsh 原 rail 行为）。
				return jsx.jsx("div", {
					className: "fi-region fi-region--rail",
					children: jsx.jsx("button", {
						type: "button",
						className: "fi-action",
						"aria-label": t("search"),
						onClick: () => expandSidebar?.(),
						children: icon(ICONS.search, 18),
					}),
				});
			}

			return jsx.jsxs("div", { className: "fi-region", children: [
				// 项目模式入口：portal 进 dsh 原生 logo 行（收起按钮左侧）
				toggleHost !== null
					? reactDom.createPortal(
						jsx.jsx(ProjectModeToggle, {
							active: mode === "project",
							onToggle: () => switchMode(mode === "project" ? "normal" : "project"),
							t,
						}),
						toggleHost,
					)
					: null,
				// 项目模式：logo 行以下整体切换为文件浏览器；普通模式：按钮列 + 任务列表
				mode === "project"
					? jsx.jsx(FileBrowser, { startNewTaskIn, t })
					: jsx.jsxs(react.Fragment, { children: [
					jsx.jsxs("div", { className: "fi-actions", children: [
						jsx.jsx(ActionButton, { label: t("newTask"), primary: true, icon: ICONS.newTask, onClick: startNewTask }),
						jsx.jsx(ActionButton, { label: t("search"), icon: ICONS.search, onClick: () => {} }),
						jsx.jsx(ActionButton, { label: t("schedule"), icon: ICONS.schedule, onClick: () => {} }),
						jsx.jsx(ActionButton, { label: t("plugins"), icon: ICONS.plugins, onClick: () => {} }),
					] }),
					jsx.jsx("div", { className: "fi-section", children:
						jsx.jsx("span", { className: "fi-section-label", children: t("section.tasks") }),
					}),
					jsx.jsx("div", { className: "fi-list", children:
						rows === null
							? jsx.jsx("div", { className: "fi-loading", children: t("empty.loading") })
							: rows.length === 0
								? jsx.jsx("div", { className: "fi-empty", children: t("empty.none") })
								: rows.map((s) => jsx.jsx(SessionRow, {
									session: s,
									selected: s.id === currentId,
									pending: typeof pending?.get === "function" && pending.get(s.id) !== undefined,
									onOpen: openSession,
									t,
								}, s.id)),
					}),
				] }),
			] });
		}
		//#endregion

		//#region file browser
		/**
		 * Electron 桥（src/preload + src/main/fs-bridge.ts）。preload 先于页面
		 * 脚本运行，模块加载时即已就位；缺失说明当前不在 fi 桌面壳里（如浏览器
		 * 直接开 dsh 网页），文件浏览器退化为提示行。
		 */
		const FI_FS = typeof window !== "undefined" ? window.fi?.fs ?? null : null;
		const FI_SHELL = typeof window !== "undefined" ? window.fi?.shell ?? null : null;
		const FI_CLIPBOARD = typeof window !== "undefined" ? window.fi?.clipboard ?? null : null;

		/** 项目模式浏览位置在本次运行内记忆：退出项目模式再进入保持原地，重启即复位。 */
		let savedStack = null;

		/**
		 * 隐藏项显隐选择持久在 localStorage，跨重启生效（与只记本次运行的位置
		 * 不同）。键缺省 = 不展示隐藏项（未动过开关时的默认）；用户点过开关后
		 * 以存储的选择为准。
		 */
		const HIDDEN_STORAGE_KEY = "fi.sidebar.showHidden";
		function readShowHidden() {
			try {
				return window.localStorage.getItem(HIDDEN_STORAGE_KEY) === "1";
			} catch {
				return false;
			}
		}
		function writeShowHidden(value) {
			try {
				window.localStorage.setItem(HIDDEN_STORAGE_KEY, value ? "1" : "0");
			} catch { /* 存储不可用时仅退化为不记忆 */ }
		}

		const pathTail = (path) => {
			const parts = path.split("/");
			return parts[parts.length - 1] || path;
		};

		function levelNote(level, t) {
			if (level.phase === "loading") return t("fb.loading");
			if (level.code === "ENOENT") return t("fb.notFound");
			if (level.code === "EPERM" || level.code === "EACCES") return t("fb.denied");
			if (level.code === "ENOTDIR") return t("fb.notDirectory");
			return format(t("fb.errorOther"), { msg: level.message || level.code });
		}

		/** 路径条：栈上每一级一个可点面包屑（首级即主目录，显示 ~），自动滚到末尾。 */
		function FbCrumbs({ stack, onJump }) {
			const ref = react.useRef(null);
			react.useEffect(() => {
				const el = ref.current;
				if (el !== null) el.scrollLeft = el.scrollWidth;
			}, [stack]);
			return jsx.jsx("div", { className: "fi-fb-crumbs", ref, children: stack.map((path, index) =>
				jsx.jsxs(react.Fragment, { children: [
					index > 0 ? jsx.jsx("span", { className: "fi-fb-sep", children: "/" }) : null,
					jsx.jsx("button", {
						type: "button",
						className: "fi-fb-crumb",
						"aria-current": index === stack.length - 1 ? "true" : undefined,
						onClick: () => onJump(index),
						children: index === 0 ? "~" : pathTail(path),
					}),
				] }, path)) });
		}

		/**
		 * 单行条目。目录：单击进入，行尾「新建任务」按钮在该文件夹里新建会话；
		 * 文件：单击用系统默认程序打开。双击（detail>1）忽略，防连点误入子目录。
		 * 断链等 other 条目灰显不可点（与 dsh 目录浏览一致）。
		 */
		function FbRow({ entry, creating, onEnter, onOpen, onNewTask, onMenu, t }) {
			if (entry.type === "other") {
				return jsx.jsx("div", { className: "fi-fb-row fi-fb-row--other", children:
					jsx.jsx("span", { className: "fi-fb-row-name", children: entry.name }) });
			}
			const isDir = entry.type === "directory";
			const hidden = entry.name.startsWith(".");
			return jsx.jsxs("button", {
				type: "button",
				className: hidden ? "fi-fb-row fi-fb-row--hidden" : "fi-fb-row",
				onClick: (event) => {
					if (event.detail > 1) return;
					if (isDir) onEnter(entry);
					else onOpen(entry);
				},
				onContextMenu: (event) => onMenu(event, entry),
				children: [
					jsx.jsx("span", { className: "fi-fb-row-icon", children:
						isDir ? icon("IconFolderClose16", 16) : null }),
					jsx.jsx("span", { className: "fi-fb-row-name", children: entry.name }),
					isDir ? jsx.jsx("span", {
						className: "fi-fb-new",
						role: "button",
						"aria-label": t("row.newTaskHere"),
						title: t("row.newTaskHere"),
						onClick: (event) => {
							event.stopPropagation();
							onNewTask(entry);
						},
						// 气泡+加号（dsh IconNewChat）：对齐 ZCode 的新建任务图标，
						// 避免裸加号在文件列表里被误读为「新建文件」。
						children: icon("IconNewChatOutline16", 14),
					}) : null,
				],
			});
		}

		/** 右键菜单。点菜单外/Escape/窗口缩放关闭；点在菜单内不关。 */
		function FbMenu({ x, y, entry, onCopy, onReveal, onOpen, onClose, t }) {
			react.useEffect(() => {
				const onDocClick = (event) => {
					if (event.target instanceof Element && event.target.closest(".fi-fb-menu")) return;
					onClose();
				};
				const onKey = (event) => {
					if (event.key === "Escape") onClose();
				};
				window.addEventListener("click", onDocClick, true);
				window.addEventListener("resize", onClose);
				window.addEventListener("keydown", onKey);
				return () => {
					window.removeEventListener("click", onDocClick, true);
					window.removeEventListener("resize", onClose);
					window.removeEventListener("keydown", onKey);
				};
			}, [onClose]);
			const items = [
				{ label: t("fb.copyPath"), iconName: "IconCopyOutline16", act: onCopy },
				{ label: t("fb.reveal"), iconName: "IconRightUpOutline14", act: onReveal },
				{ label: t("fb.open"), iconName: "IconFolderOpenOutline16", act: onOpen },
			];
			const style = {
				left: Math.max(4, Math.min(x, window.innerWidth - 188)),
				top: Math.max(4, Math.min(y, window.innerHeight - items.length * 34 - 12)),
			};
			return jsx.jsx("div", { className: "fi-fb-menu", style, children: items.map((item) =>
				jsx.jsx("button", {
					type: "button",
					className: "fi-fb-menu-item",
					onClick: () => item.act(entry),
					children: [icon(item.iconName, 14), item.label],
				}, item.label)) });
		}

		/**
		 * 项目模式主体：Finder 式逐层进入的文件浏览器。层级栈（stack）既是导航
		 * 状态也是路径条数据；每层内容按路径缓存，返回上级即时呈现，刷新按钮
		 * 强制重读当前层。位置在 savedStack 里跨项目模式开关保持。
		 */
		function FileBrowser({ startNewTaskIn, t }) {
			const [stack, setStack] = react.useState(savedStack);
			const [showHidden, setShowHidden] = react.useState(readShowHidden);
			const [levels, setLevels] = react.useState({});
			const [menu, setMenu] = react.useState(null);
			const [status, setStatus] = react.useState(null);
			const [creating, setCreating] = react.useState(false);
			const statusTimer = react.useRef(undefined);

			const toggleHidden = () => {
				setShowHidden((prev) => {
					const next = !prev;
					writeShowHidden(next);
					return next;
				});
			};

			const current = stack === null ? null : stack[stack.length - 1];
			const level = current === null ? undefined : levels[current];

			// 不在 fi 桌面壳里：没有文件桥，退化为提示行（dsh 网页版直接打开时）。
			if (FI_FS === null) {
				return jsx.jsx("div", { className: "fi-fb", children:
					jsx.jsx("div", { className: "fi-fb-note", children: t("fb.desktopOnly") }) });
			}

			react.useEffect(() => {
				if (stack === null) {
					if (FI_FS === null) return;
					let gone = false;
					FI_FS.home().then((r) => {
						if (!gone && r?.ok === true) setStack([r.path]);
					}).catch(() => {});
					return () => { gone = true; };
				}
				savedStack = stack;
			}, [stack]);

			const loadLevel = react.useCallback((path) => {
				setLevels((prev) => ({ ...prev, [path]: { phase: "loading" } }));
				FI_FS.readdir(path).then((r) => {
					setLevels((prev) => ({ ...prev, [path]: r?.ok === true
						? { phase: "ready", entries: r.entries, truncated: r.truncated }
						: { phase: "failed", code: r?.code ?? "unknown", message: r?.message ?? "" } }));
				}).catch((err) => {
					setLevels((prev) => ({ ...prev, [path]: { phase: "failed", code: "unknown", message: String(err) } }));
				});
			}, []);

			react.useEffect(() => {
				if (current !== null && levels[current] === undefined) loadLevel(current);
			}, [current, levels, loadLevel]);

			const showStatus = (text) => {
				setStatus(text);
				if (statusTimer.current !== undefined) window.clearTimeout(statusTimer.current);
				statusTimer.current = window.setTimeout(() => setStatus(null), 2500);
			};

			const enter = (entry) => setStack((prev) => [...prev, entry.path]);
			const jump = (index) => setStack((prev) => prev.slice(0, index + 1));
			const goUp = () => setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
			const refresh = () => {
				if (current !== null) loadLevel(current);
			};

			const openFile = (entry) => {
				FI_SHELL?.open(entry.path).then((r) => {
					if (r?.ok !== true) showStatus(format(t("fb.openFailed"), { msg: r?.message ?? "" }));
				}).catch(() => {});
			};
			const newTask = (entry) => {
				if (creating) return;
				setCreating(true);
				Promise.resolve(startNewTaskIn(entry.path)).then((err) => {
					setCreating(false);
					if (err) showStatus(format(t("fb.taskFailed"), { msg: err }));
				});
			};

			let body;
			if (level === undefined || level.phase === "loading") {
				body = jsx.jsx("div", { className: "fi-fb-note", children: t("fb.loading") });
			} else if (level.phase === "failed") {
				body = jsx.jsx("div", { className: "fi-fb-note", children: levelNote(level, t) });
			} else {
				// 隐藏项开关只影响展示，不动缓存：关掉后再打开无需重读目录。
				const entries = showHidden
					? level.entries
					: level.entries.filter((entry) => !entry.name.startsWith("."));
				body = entries.length === 0
					? jsx.jsx("div", { className: "fi-fb-note", children: t("fb.emptyDir") })
					: jsx.jsxs(react.Fragment, { children: [
						entries.map((entry) => jsx.jsx(FbRow, {
							entry,
							onEnter: enter,
							onOpen: openFile,
							onNewTask: newTask,
							onMenu: (event, row) => {
								event.preventDefault();
								setMenu({ x: event.clientX, y: event.clientY, entry: row });
							},
							t,
						}, entry.path)),
						level.truncated
							? jsx.jsx("div", { className: "fi-fb-note", children:
								format(t("fb.truncated"), { n: entries.length }) })
							: null,
					] });
			}

			return jsx.jsxs("div", { className: "fi-fb", children: [
				jsx.jsxs("div", { className: "fi-fb-bar", children: [
					jsx.jsx("button", {
						type: "button",
						className: "fi-fb-nav",
						"aria-label": t("fb.back"),
						title: t("fb.back"),
						disabled: stack === null || stack.length <= 1,
						onClick: goUp,
						children: icon("IconChevronLeftOutline14", 14),
					}),
					stack === null ? null : jsx.jsx(FbCrumbs, { stack, onJump: jump }),
					// 「.*」= dotfiles：按下为展示隐藏项，弹起为隐藏（未动过开关时默认隐藏）
					jsx.jsx("button", {
						type: "button",
						className: "fi-fb-nav",
						"aria-label": t("fb.toggleHidden"),
						title: t("fb.toggleHidden"),
						"aria-pressed": showHidden ? "true" : "false",
						onClick: toggleHidden,
						children: jsx.jsx("span", { className: "fi-fb-nav-text", children: ".*" }),
					}),
					jsx.jsx("button", {
						type: "button",
						className: "fi-fb-nav",
						"aria-label": t("fb.refresh"),
						title: t("fb.refresh"),
						disabled: current === null,
						onClick: refresh,
						children: icon("IconRefreshOutline16", 14),
					}),
				] }),
				status !== null ? jsx.jsx("div", { className: "fi-fb-status", children: status }) : null,
				jsx.jsx("div", { className: "fi-fb-list", children: body }),
				menu !== null ? jsx.jsx(FbMenu, {
					x: menu.x,
					y: menu.y,
					entry: menu.entry,
					onCopy: (row) => {
						// 复制成功不提示（系统惯例）；失败也静默——写剪贴板基本不会失败。
						FI_CLIPBOARD?.write(row.path)?.catch?.(() => {});
						setMenu(null);
					},
					onReveal: (row) => {
						FI_SHELL?.showInFolder(row.path)?.catch?.(() => {});
						setMenu(null);
					},
					onOpen: (row) => {
						openFile(row);
						setMenu(null);
					},
					onClose: () => setMenu(null),
					t,
				}) : null,
			] });
		}
		//#endregion

		//#region plugin
		const inject = ["slots", "locale", "uiWorkspace", "workspaces"];

		function apply(ctx) {
			const uiWorkspace = ctx.get("uiWorkspace");
			const workspaces = ctx.get("workspaces");

			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "fi-sidebar: dictionaries");

			const startNewTask = () => {
				// 服务端半层通常已建好 default 工作区；极端情况下（未就绪/建区失败）
				// 退化为 dsh 原生行为：继承当前/最近工作区。
				const ws = workspaces.list.getSnapshot().items.find((w) => w.title === DEFAULT_WORKSPACE_TITLE);
				uiWorkspace.startSession(ws === undefined ? undefined : ws.workspaceId);
			};
			const openSession = (sessionId) => uiWorkspace.openSession(sessionId);
			/**
			 * 项目模式核心动作：在所选文件夹里新建任务。workspaces.create 幂等
			 * （已是工作区的目录原样返回并立即合入客户端投影），startSession 复用
			 * 该工作区里未发送过消息的 blank 会话，否则新建，然后在右侧打开。
			 * 返回 null 或用户可读的错误信息（浏览器行内提示）。
			 */
			const startNewTaskIn = (dirPath) => workspaces.create({ path: dirPath })
				.then((ws) => {
					uiWorkspace.startSession(ws.workspaceId);
					return null;
				})
				.catch((err) => err?.message ?? String(err));

			ctx.slots.inject("sidebar.workspaces", () => ctx.slots.register({
				name: "sidebar.workspaces",
				priority: -1,
				inject: () => ({ startNewTask, startNewTaskIn, openSession }),
				locale: NS,
			}, FiSidebarRegion));
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
