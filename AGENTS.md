# Agent Guidance

## Project conventions

- This repository is a TypeScript Obsidian plugin. Follow the existing TypeScript style and Obsidian APIs; Android-specific conventions do not apply here.
- Keep the architecture modular: route host lifecycle and feature communication through the event bus, keep file-type behavior in the registry/settings, and implement renderers, metadata handling, and extractors in their respective modules.
- Keep user settings backward-compatible. Merge persisted data with defaults and validate custom extensions and directory regular expressions.
- Preserve user-authored companion-note content when updating managed extraction sections.
- Add or update Vitest coverage for behavior changes, especially settings, file-type modes, pairing, and managed Markdown updates.
- Do not commit generated output such as `main.js`, `dist/`, coverage, or `node_modules/`.

## Useful commands

```sh
npm ci
npm test
npm run build
npm run package:plugin
```

`npm run build` performs TypeScript checking and produces the production bundle. `npm run package:plugin` stages a clean installable plugin directory at `dist/obsidian-file-support/`. The project targets Node.js 20 in CI.

## Source map

- `src/core/`: event bus and file-type registry.
- `src/settings/`: persisted plugin settings and Obsidian settings UI.
- `src/renderers/`, `src/views/`, and `src/embeds/`: CodeMirror renderer, file tabs, and inline embeds.
- `src/metadata/` and `src/middlewares/`: companion note resolution, extractor integration, and File Explorer behavior.
- `src/extractors/`: pluggable content extraction adapters.
- `tests/`: Vitest unit and integration tests.