import { App, PluginSettingTab, Setting } from "obsidian";
import type VimiumPlugin from "./main";

/** A user-defined key that runs a command palette command. Only the webview bridge still reads these; the host fires no keys. */
export interface KeyBinding {
	/** KeyboardEvent.key value, e.g. "x", "X", "ArrowDown". Empty = unset. */
	key: string;
	/** Command id, e.g. "editor:toggle-bold". Empty = unset. */
	commandId: string;
	/** Command display name, kept so rows stay readable if a plugin is disabled. */
	commandName: string;
}

/** A user-defined key that runs a shell command. Same note as KeyBinding. */
export interface TerminalCommand {
	/** Key sequence, like KeyBinding.key. Empty = unset. */
	key: string;
	/** Shell command template; {{path}}, {{folder}}, {{vault}} are substituted. */
	command: string;
}

export interface VimiumSettings {
	/** Characters used to build hint labels (in priority order). */
	hintChars: string;
	/** CSS selectors whose matching, visible elements become hint targets. */
	selectors: string[];
	/** Font size (px) of hint markers. */
	hintFontSize: number;
	/** Pixels scrolled per j/k press. */
	scrollStep: number;
	/** Turn on Obsidian's native Vim key bindings on load. */
	enableNativeVim: boolean;
	/** Inject vim keys and hints into Web viewer tabs (Electron webviews). */
	enableWebviewIntegration: boolean;
	/** Custom reading-mode key bindings. They override the built-in keys. */
	keyBindings: KeyBinding[];
	/** Keys that spawn a shell command (desktop only). */
	terminalCommands: TerminalCommand[];
}

export const DEFAULT_SELECTORS = [
	// App chrome
	".workspace-tab-header",
	".workspace-tab-header-inner",
	".side-dock-ribbon-action",
	".clickable-icon",
	".nav-file-title",
	".nav-folder-title",
	".tree-item-self",
	".menu-item",
	// Rendered note content (Reading view)
	".markdown-preview-view a",
	".markdown-preview-view .internal-link",
	".markdown-preview-view .external-link",
	".markdown-preview-view .tag",
	".markdown-preview-view .task-list-item-checkbox",
	".markdown-preview-view button",
	".markdown-embed-link",
	// Any note or base in the main area, whatever view renders it
	".workspace-leaf-content a",
	".workspace-leaf-content button",
	".workspace-leaf-content input[type=\"checkbox\"]",
	".bases-view a",
	".bases-view .internal-link",
	".bases-view .external-link",
	".bases-view button",
	// Live preview / editor link widgets (verified against obsidian.asar)
	".cm-hmd-internal-link",
	".cm-hmd-barelink",
	".cm-link",
];

export const DEFAULT_SETTINGS: VimiumSettings = {
	// Home-row-first alphabet, like Vimium.
	hintChars: "sadfjklewcmpgh",
	selectors: DEFAULT_SELECTORS,
	hintFontSize: 11,
	scrollStep: 70,
	enableNativeVim: true,
	enableWebviewIntegration: true,
	keyBindings: [
		{
			key: "p",
			commandId: "command-palette:open",
			commandName: "Command palette: Open command palette",
		},
		{
			key: "o",
			commandId: "switcher:open",
			commandName: "Quick switcher: Open quick switcher",
		},
	],
	terminalCommands: [],
};

export class VimiumSettingTab extends PluginSettingTab {
	plugin: VimiumPlugin;

	constructor(app: App, plugin: VimiumPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Hint characters")
			.setDesc("Characters used to generate hint labels, in priority order.")
			.addText((text) => {
				text
					.setValue(this.plugin.settings.hintChars)
					.onChange(async (value) => {
						const cleaned = [
							...new Set(value.toLowerCase().replace(/[^a-z]/g, "")),
						].join("");
						this.plugin.settings.hintChars = cleaned || DEFAULT_SETTINGS.hintChars;
						await this.plugin.saveSettings();
					});
				// Show what was actually saved (deduped/lowercased, or the
				// default if the field was emptied).
				text.inputEl.addEventListener("blur", () => {
					text.setValue(this.plugin.settings.hintChars);
				});
			});

		new Setting(containerEl)
			.setName("Hint font size")
			.setDesc("Font size of the hint markers, in pixels.")
			.addSlider((slider) =>
				slider
					.setLimits(8, 24, 1)
					.setValue(this.plugin.settings.hintFontSize)
					.onChange(async (value) => {
						this.plugin.settings.hintFontSize = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Web viewer integration")
			.setDesc("Inject the vim keys (scrolling, hints, tab switching) into Web viewer pages. Custom key bindings and terminal commands still require focus to be outside the page.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableWebviewIntegration)
					.onChange(async (value) => {
						this.plugin.settings.enableWebviewIntegration = value;
						await this.plugin.saveSettings();
						this.plugin.applyWebviewIntegration(value);
					})
			);

		new Setting(containerEl)
			.setName("Hint target selectors")
			.setDesc("One CSS selector per line. Visible elements matching any selector become hint targets.")
			.addTextArea((text) => {
				text
					.setValue(this.plugin.settings.selectors.join("\n"))
					.onChange(async (value) => {
						this.plugin.settings.selectors = value
							.split("\n")
							.map((s) => s.trim())
							.filter((s) => s.length > 0);
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 12;
				text.inputEl.addClass("vimium-selectors-input");
			});

	}
}
