import { App, MarkdownView, WorkspaceLeaf } from "obsidian";
import { VimiumSettings } from "./settings";

/**
 * Reading vs editing is owned by Obsidian's own view (preview vs source)
 * and native Vim — this plugin keeps no mode of its own. The only job left
 * here is the `i` key: if the active note is in Reading view, flip that leaf
 * into the editor, drop the cursor where you were reading, focus it, and
 * (with native Vim on) land straight in insert mode. Everywhere else Vim
 * owns its keys untouched.
 */
export class ModeManager {
	private app: App;
	private settings: VimiumSettings;

	constructor(app: App, settings: VimiumSettings) {
		this.app = app;
		this.settings = settings;
	}

	/** Switch the active note into the editor (live preview) and focus it. */
	async enterEditing(): Promise<void> {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		const centerLine = this.getReadingCenterLine(view);

		await this.setLeafMode(view.leaf, "source");
		const fresh = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (fresh && centerLine !== null) {
			const pos = { line: centerLine, ch: 0 };
			fresh.editor.setCursor(pos);
			fresh.editor.scrollIntoView({ from: pos, to: pos }, true);
		}
		fresh?.editor.focus();
		// With native Vim on, drop straight into insert mode so a single `i`
		// goes from reading to typing. This replays the keystroke through the
		// exact same path as pressing `i` by hand, whatever Vim build is
		// underneath — no Vim internals touched.
		if (this.settings.enableNativeVim) {
			try {
				const target = activeDocument.activeElement as HTMLElement | null;
				target?.dispatchEvent(
					new KeyboardEvent("keydown", {
						key: "i",
						code: "KeyI",
						bubbles: true,
						cancelable: true,
					})
				);
			} catch {
				// Fall back to a normal-mode landing.
			}
		}
	}

	/**
	 * Estimate which source line sits at the vertical center of the Reading
	 * view's viewport, so `enterEditing` can drop the cursor there instead of
	 * wherever the editor's cursor last happened to be. Obsidian only exposes
	 * the top-of-viewport line (`previewMode.getScroll()`), so the center is
	 * approximated by scaling the total line count by how much of the
	 * document's rendered height is currently visible.
	 */
	private getReadingCenterLine(view: MarkdownView): number | null {
		const totalLines = view.editor.lineCount();
		if (totalLines <= 0) return null;

		const container = view.containerEl.querySelector<HTMLElement>(
			".markdown-preview-view"
		);
		if (!container || container.scrollHeight <= 0) return null;

		const topLine = view.previewMode.getScroll();
		const viewportLines =
			(container.clientHeight / container.scrollHeight) * totalLines;
		const centerLine = Math.round(topLine + viewportLines / 2);

		return Math.min(Math.max(centerLine, 0), totalLines - 1);
	}

	private async setLeafMode(
		leaf: WorkspaceLeaf,
		mode: "source" | "preview"
	): Promise<void> {
		const state = leaf.getViewState();
		if (state.type !== "markdown") return;
		state.state = { ...state.state, mode };
		if (mode === "source") {
			// Prefer live preview rather than raw source.
			state.state.source = false;
		}
		await leaf.setViewState(state);
	}
}
