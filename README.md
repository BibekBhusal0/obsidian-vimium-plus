# Vimium+ (modeless fork)

Click hints for Obsidian, nothing else. Invoke "Show click hints" (or "…in a new tab") from the command palette or a hotkey and type the label to click: links, buttons, checkboxes, tabs, ribbon, file tree. There are no plugin modes and no built-in keys — Obsidian's own views and native Vim own every key.

![Click hints shown over links, tabs, and the file tree after pressing `f`](assets/hints.png)

> Not affiliated with the [Vimium](https://github.com/philc/vimium) browser extension or the existing Vimium community plugin — this is an independent reimplementation of the Vimium idea for Obsidian.

## Keys

No built-in keys. Bind these two commands to hotkeys (e.g. Alt+F):

- Show click hints
- Show click hints (open in new tab)

While hints are showing: type the label to activate, `Backspace` to correct, `Esc` to cancel. Holding `Shift` on the **last** letter of a label opens that target in a new tab (even if you started with plain hints).

## Web viewer tabs

The vim keys also work inside pages opened with Obsidian's core **Web viewer** plugin. Web pages render in a separate Electron webview that the plugin can't reach directly, so a small self-contained script is injected into each page instead (toggleable in settings as **Web viewer integration**).

Inside a page: `j`/`k`/`d`/`u`/`gg`/`G` scroll, `f`/`F` show hints over the page's links and controls (`F` opens the link in a new Web viewer tab), `H`/`L` go back/forward in the page's history, and `J`/`K`/`t`/`x` switch/open/close Obsidian tabs. Typing in a page's text field passes keys through as usual; `Esc` blurs the field, and `Esc` again hands focus back to Obsidian.

Limitations: custom key bindings and terminal commands don't fire while the page itself has focus (the page-to-Obsidian channel is intentionally restricted to a small fixed set of actions, since a malicious page could forge it) — press `Esc` first, then they work as normal. Hints cover the page's top frame only, and some pages (PDFs, error pages) refuse script injection entirely.

## How it maps to Obsidian

The plugin keeps no mode of its own: Reading view gets the Vimium keys, the editor keeps every key for Vim and typing. It turns on Obsidian's native Vim key bindings, so `i` lands you in a real Vim editor already inserting. The Vim setting is restored when you disable the plugin.

## Settings

Hint characters, hint font size, scroll step, native-Vim toggle, Web viewer integration toggle, and the list of CSS selectors that become hint targets.

## Build

Requires Node.js (18+).

```bash
npm install
npm run dev      # esbuild watch → main.js
npm run build    # type-check + production bundle
```

## Install into a vault

Copy (or symlink) `manifest.json`, `main.js`, and `styles.css` into:

```
<your-vault>/.obsidian/plugins/vimium-plus/
```

Then enable **Vimium+** under Settings → Community plugins (turn on community plugins first if needed).

For active development, symlink the repo so each rebuild is picked up:

```bash
ln -s "$(pwd)" "<your-vault>/.obsidian/plugins/vimium-plus"
```

…and reload Obsidian (or use the Hot-Reload plugin) after each build.

## Verify it works

1. Open any note.
2. Invoke "Show click hints" → hint letters appear over links/buttons/checkboxes (in the note **and** on tabs/ribbon/file tree); type a label to click it; `Esc` cancels. The new-tab variant opens the link in a new tab.
3. Typing in the search box is **not** hijacked.
