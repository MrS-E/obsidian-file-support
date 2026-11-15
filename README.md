# File Support for Obsidian

File Support adds viewing and embedding support for text, code, data, log, and patch files that Obsidian does not handle as Markdown notes. Supported files can be opened in dedicated CodeMirror tabs, embedded in notes, and identified by extension badges in the File Explorer.

## Features

- Built-in support for `txt`, `json`, `js`, `ts`, `c`, `h`, `cpp`, `rb`, `py`, `sh`, `yaml`, `yml`, `toml`, `xml`, `ini`, `cfg`, `log`, `patch`, and `diff` files.
- Configurable per-extension enablement, badge label, tab editability, and embed editability; embeds are read-only by default.
- Optional companion Markdown metadata notes, disabled by default, with a configurable folder-path regular expression.
- A pluggable event-bus, renderer, and extractor design intended to support future file formats and processing adapters.

## Install

1. Download the `obsidian-file-support` artifact from a successful GitHub Actions build, or run `npm run package:plugin` locally and use `dist/obsidian-file-support/`.
2. Copy the files inside that directory into `<vault>/.obsidian/plugins/obsidian-file-support/`.
3. In Obsidian, enable **File Support** under **Settings → Community plugins**.

The installable plugin directory contains `main.js`, `manifest.json`, and `styles.css` only.

## Use

Once enabled, supported extensions are registered with Obsidian. Link to a file with normal wiki-link syntax, such as `[[server.log]]`, or embed it with `![[server.log]]`. Supported files display an extension badge in the File Explorer.

The plugin's settings let you enable or disable extensions and configure their tab and embed edit modes. Code, text, and data presets open in editable tabs by default; `log`, `patch`, and `diff` presets open read-only. Embeds default to read-only for every built-in type.

### Companion metadata notes

Enable **Companion Metadata Notes** in the plugin settings to use a companion `.md` note for a supported file. The note is resolved on demand, linked to its target with the `file-support-target` frontmatter property, and hidden in the File Explorer while its target is underlined. A folder-path regular expression limits where companion notes are active. Use `Alt`-click on a target in the File Explorer, the companion metadata command, or the view's metadata action to open or create its companion note. If a same-basename Markdown file is already in use, the resolver falls back from `<basename>.md` to `<basename>.<ext>.md` (for example, `server.log.md`).

## Development

Requirements: Node.js 20 and npm.

```sh
npm ci
npm test
npm run build
npm run package:plugin
```

`npm run build` type-checks the TypeScript sources and creates the production bundle at the repository root. `npm run package:plugin` runs that build, then refreshes `dist/obsidian-file-support/` with the installable runtime files. The GitHub Actions workflow runs tests and packages the same directory on pushes, pull requests, and manual dispatches.

See [`AGENTS.md`](AGENTS.md) for repository-specific contribution and validation guidance.