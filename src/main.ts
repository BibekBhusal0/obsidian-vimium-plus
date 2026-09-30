import { MarkdownView, Plugin } from "obsidian";
import {
	DEFAULT_SETTINGS,
	VimiumSettings,
	VimiumSettingTab,
} from "./settings";
import { HintEngine } from "./hints/hint-engine";
import { WebviewBridge } from "./webview";

export default class VimiumPlugin extends Plugin {
	settings!: VimiumSettings;

	private hintEngine!: HintEngine;
	private webviewBridge!: WebviewBridge;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.hintEngine = new HintEngine(this.app, this.settings, () => {});
		this.webviewBridge = new WebviewBridge(
			this.app,
			() => this.settings,
			() => {}
		);

		this.addSettingTab(new VimiumSettingTab(this.app, this));

		// Capture-phase so we intercept before CodeMirror / Obsidian handlers.
		// Bound per window so pop-out windows work too.
		this.bindWindow(activeDocument);
		this.registerEvent(
			this.app.workspace.on("window-open", (win) => this.bindWindow(win.doc))
		);

		// The editor owns its keys; nothing to sync when leaves change.
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.webviewBridge.ensureAll();
			})
		);
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.webviewBridge.ensureAll();
			})
		);

		this.registerCommands();

		this.app.workspace.onLayoutReady(() => {
			this.webviewBridge.ensureAll();
		});
	}

	onunload(): void {
		this.webviewBridge?.destroy();
		this.hintEngine?.hide();
	}

	// ---- settings -----------------------------------------------------------

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<VimiumSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// Keep live webview guests in sync with hint/scroll settings.
		this.webviewBridge?.reinjectAll();
	}

	/** Turn the Web viewer (webview) integration on or off at runtime. */
	applyWebviewIntegration(enabled: boolean): void {
		this.webviewBridge?.setEnabled(enabled);
	}

	private bindWindow(doc: Document): void {
		this.registerDomEvent(doc, "keydown", (e) => this.onKeyDown(e), {
			capture: true,
		});
	}

	// ---- commands -----------------------------------------------------------

	private registerCommands(): void {
		this.addCommand({
			id: "show-hints",
			name: "Show click hints",
			callback: () => this.showHints(false),
		});
		this.addCommand({
			id: "show-hints-new-tab",
			name: "Show click hints (open in new tab)",
			callback: () => this.showHints(true),
		});
	}

	// ---- key routing --------------------------------------------------------

	private onKeyDown(e: KeyboardEvent): void {
		// Hint capture takes priority over everything else.
		if (this.hintEngine.active) {
			if (this.hintEngine.handleKey(e)) {
				e.preventDefault();
				e.stopPropagation();
			}
			return;
		}

		// Letters for a guest (webview) hint session started from host focus
		// are relayed into the page, since focus() after a keyboard tab-switch
		// is not reliable.
		if (this.webviewBridge.hintRelayActive) {
			if (this.webviewBridge.relayHintKey(e.key)) {
				e.preventDefault();
				e.stopPropagation();
			}
			return;
		}

		// A webview leaf is never a markdown editor; guard the editing check
		// so webview keys keep working regardless of view state.
		const webviewActive = this.webviewBridge.activeWebview() !== null;
		// The editor owns its keys: in source/live-preview mode native Vim
		// (or plain typing) gets everything, including Escape. In Reading
		// view there are no built-in keys left either — hints fire only
		// from their commands (palette/hotkeys, e.g. Alt+F).
		if (!webviewActive && this.isEditingView()) return;
	}

	/** Hints on the active surface: the webview guest if present, else the host. */
	private showHints(newTab: boolean): void {
		const webview = this.webviewBridge.activeWebview();
		if (webview) this.webviewBridge.startHints(webview, newTab);
		else this.hintEngine.show(newTab);
	}

	/** True when the active note is open in the editor (source/live preview). */
	private isEditingView(): boolean {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		return !!view && view.getMode() !== "preview";
	}
}
