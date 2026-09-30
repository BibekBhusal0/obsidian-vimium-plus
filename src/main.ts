import { MarkdownView, Plugin } from "obsidian";
import {
	DEFAULT_SETTINGS,
	VimiumSettings,
	VimiumSettingTab,
} from "./settings";
import { ModeManager } from "./mode";
import { HintEngine } from "./hints/hint-engine";
import { Scroller } from "./scroll";
import { WebviewBridge } from "./webview";
import {
	OmniOpenModal,
	collectBookmarkItems,
	collectRecentFileItems,
} from "./omnibar";
import { runTerminalCommand } from "./exec";

export default class VimiumPlugin extends Plugin {
	settings!: VimiumSettings;

	private modeManager!: ModeManager;
	private hintEngine!: HintEngine;
	private scroller!: Scroller;
	private webviewBridge!: WebviewBridge;

	// Keys buffered while they are still a prefix of some key sequence.
	private pendingKeys = "";
	private pendingTimer: number | null = null;

	// Whether the editor's global Vim setting was changed by us, so unload
	// can restore it. Tracked with an explicit flag: the previous value may
	// legitimately be undefined (config key never set), so it can't double
	// as the flag.
	private vimModeChanged = false;
	private prevVimMode: unknown = false;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.modeManager = new ModeManager(this.app, this.settings);
		this.hintEngine = new HintEngine(this.app, this.settings, () => {});
		this.scroller = new Scroller(this.app);
		this.webviewBridge = new WebviewBridge(
			this.app,
			() => this.settings,
			() => {}
		);

		this.applyEditorConfig();

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
		this.clearPending();
		this.restoreEditorConfig();
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

	private applyEditorConfig(): void {
		if (this.settings.enableNativeVim) this.applyNativeVim(true);
	}

	private restoreEditorConfig(): void {
		this.applyNativeVim(false);
	}

	/** Turn the editor's global Vim setting on, or restore what it was. */
	applyNativeVim(enabled: boolean): void {
		const vault = this.app.vault;
		if (enabled) {
			if (this.vimModeChanged) return;
			this.prevVimMode = vault.getConfig("vimMode") ?? false;
			this.vimModeChanged = true;
			vault.setConfig("vimMode", true);
		} else if (this.vimModeChanged) {
			this.vimModeChanged = false;
			vault.setConfig("vimMode", this.prevVimMode);
		}
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
		this.addCommand({
			id: "enter-editing",
			name: "Enter editing mode",
			callback: () => void this.modeManager.enterEditing(),
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
		// (or plain typing) gets everything, including Escape. Reading keys
		// only run in Reading view — Obsidian's own view, not a plugin mode.
		if (!webviewActive && this.isEditingView()) return;

		// --- reading view ---
		if (isEditableTarget()) return;
		// Leave OS/Obsidian shortcuts (Ctrl/Cmd/Alt) untouched. Shift is ours.
		if (e.ctrlKey || e.metaKey || e.altKey) return;

		if (this.handleReadingKey(e)) {
			e.preventDefault();
			e.stopPropagation();
		}
	}

	private handleReadingKey(e: KeyboardEvent): boolean {
		// Pure modifier presses must not pollute the sequence buffer.
		if (e.key === "Shift") return false;
		return this.feedKey(e.key);
	}

	/**
	 * Advance the key-sequence state machine with one key. Custom bindings
	 * (which may be multi-key sequences like "gT") and the built-in `gg` chord
	 * are matched longest-first; while the typed keys are still a prefix of
	 * some sequence they are buffered until the chord timeout resolves the
	 * ambiguity. Custom bindings win over built-ins on an equal match.
	 */
	private feedKey(key: string): boolean {
		const hadPending = this.pendingKeys.length > 0;
		const candidate = this.pendingKeys + key;
		const targets = this.sequenceTargets();
		const exact = targets.find((t) => t.seq === candidate);
		const extendable = targets.some(
			(t) => t.seq.length > candidate.length && t.seq.startsWith(candidate)
		);

		if (extendable) {
			this.setPending(candidate, exact);
			return true;
		}
		this.clearPending();
		if (exact) {
			exact.run();
			return true;
		}
		if (hadPending) {
			// Dead-end chord: drop the buffered prefix, give this key a fresh start.
			return this.feedKey(key);
		}
		return this.runBuiltinKey(key);
	}

	/** Every multi-key-capable target: custom bindings and terminal commands first, then `gg`. */
	private sequenceTargets(): { seq: string; run: () => void }[] {
		const targets: { seq: string; run: () => void }[] = this.settings.keyBindings
			.filter((b) => b.key.length > 0 && b.commandId)
			.map((b) => ({
				seq: b.key,
				run: () => void this.app.commands.executeCommandById(b.commandId),
			}));
		for (const cmd of this.settings.terminalCommands) {
			if (cmd.key.length > 0 && cmd.command) {
				targets.push({
					seq: cmd.key,
					run: () => runTerminalCommand(this.app, cmd.command),
				});
			}
		}
		targets.push({
			seq: "gg",
			run: () => {
				const webview = this.webviewBridge.activeWebview();
				if (webview) this.webviewBridge.run(webview, "top");
				else this.scroller.toTop();
			},
		});
		return targets;
	}

	private setPending(candidate: string, exact?: { run: () => void }): void {
		this.clearPending();
		this.pendingKeys = candidate;
		this.pendingTimer = window.setTimeout(() => {
			this.pendingKeys = "";
			this.pendingTimer = null;
			// The sequence was never completed: fall back to what the buffered
			// keys meant on their own (a shorter custom binding, or a built-in).
			if (exact) {
				exact.run();
			} else if (candidate.length === 1) {
				this.runBuiltinKey(candidate);
			}
		}, VimiumPlugin.CHORD_TIMEOUT_MS);
	}

	private clearPending(): void {
		this.pendingKeys = "";
		if (this.pendingTimer !== null) {
			window.clearTimeout(this.pendingTimer);
			this.pendingTimer = null;
		}
	}

	private static readonly CHORD_TIMEOUT_MS = 600;

	private runBuiltinKey(key: string): boolean {
		// On a webview (Web viewer) leaf with host focus, scroll/hint/history
		// keys are forwarded into the guest page; everything else keeps its
		// normal Obsidian behavior.
		const webview = this.webviewBridge.activeWebview();
		switch (key) {
			case "f":
				this.showHints(false);
				return true;
			case "F":
				this.showHints(true);
				return true;
			case "j":
				if (webview) this.webviewBridge.run(webview, "scrollDown");
				else this.scroller.lineDown(this.settings.scrollStep);
				return true;
			case "k":
				if (webview) this.webviewBridge.run(webview, "scrollUp");
				else this.scroller.lineUp(this.settings.scrollStep);
				return true;
			case "J":
				this.app.commands.executeCommandById("workspace:next-tab");
				return true;
			case "K":
				this.app.commands.executeCommandById("workspace:previous-tab");
				return true;
			case "d":
				if (webview) this.webviewBridge.run(webview, "halfDown");
				else this.scroller.halfPageDown();
				return true;
			case "u":
				if (webview) this.webviewBridge.run(webview, "halfUp");
				else this.scroller.halfPageUp();
				return true;
			case "G":
				if (webview) this.webviewBridge.run(webview, "bottom");
				else this.scroller.toBottom();
				return true;
			case "i":
				void this.modeManager.enterEditing();
				return true;
			case "b":
				this.openBookmarkSearch(false);
				return true;
			case "B":
				this.openBookmarkSearch(true);
				return true;
			case "O":
				this.openOmnibar();
				return true;
			case "/":
				this.app.commands.executeCommandById("editor:open-search");
				return true;
			case "t":
				this.app.commands.executeCommandById("workspace:new-tab");
				return true;
			case "x":
				this.app.commands.executeCommandById("workspace:close");
				return true;
			case "X":
				this.app.commands.executeCommandById("workspace:undo-close-pane");
				return true;
			case "H":
				// Page history on a web tab; Obsidian leaf history elsewhere.
				if (webview) this.webviewBridge.run(webview, "historyBack");
				else this.app.commands.executeCommandById("app:go-back");
				return true;
			case "L":
				if (webview) this.webviewBridge.run(webview, "historyForward");
				else this.app.commands.executeCommandById("app:go-forward");
				return true;
		}

		return false;
	}

	/** Hints on the active surface: the webview guest if present, else the host. */
	private showHints(newTab: boolean): void {
		const webview = this.webviewBridge.activeWebview();
		if (webview) this.webviewBridge.startHints(webview, newTab);
		else this.hintEngine.show(newTab);
	}

	private openBookmarkSearch(newTab: boolean): void {
		new OmniOpenModal(
			this.app,
			collectBookmarkItems(this.app),
			newTab,
			false
		).open();
	}

	/** `O`: bookmarks + recent files + raw URLs, opening in a new tab. */
	private openOmnibar(): void {
		const items = collectBookmarkItems(this.app);
		const seen = new Set(items.map((i) => i.detail));
		for (const item of collectRecentFileItems(this.app)) {
			if (!seen.has(item.detail)) items.push(item);
		}
		new OmniOpenModal(this.app, items, true, true).open();
	}

	/** True when the active note is open in the editor (source/live preview). */
	private isEditingView(): boolean {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		return !!view && view.getMode() !== "preview";
	}
}

/** True when focus is in a text field where our keys must not be hijacked. */
function isEditableTarget(): boolean {
	const el = activeDocument.activeElement as HTMLElement | null;
	if (!el) return false;
	const tag = el.tagName;
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
	if (el.isContentEditable) return true;
	return false;
}
