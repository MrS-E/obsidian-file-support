import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Menu,
  Notice,
  TFile,
  createMockApp,
  createMockLeaf,
  createMockManifest,
  createMockTFile,
  normalizePath,
} from "./__mocks__/obsidian";
import { EventBus } from "../src/core/EventBus";
import { FileTypeRegistry } from "../src/core/FileTypeRegistry";
import {
  DEFAULT_EXTRACTOR_ID,
  EXTRACTED_SECTION_END_MARKER,
  EXTRACTED_SECTION_START_MARKER,
  ExtractorMiddleware,
  ExtractorRegistry,
  NONE_EXTRACTOR_ID,
  NOOP_EXTRACTOR_ID,
  NoOpPassthroughExtractor,
  PassthroughExtractor,
  REFRESH_EXTRACTED_METADATA_COMMAND_ID,
  REFRESH_EXTRACTED_METADATA_TITLE,
  detectLineEnding,
  hasExtractedMarkdownSection,
  readExtractedMarkdownSection,
  splitMarkdownFrontmatterAndBody,
  updateExtractedMarkdownSection,
} from "../src/extractors/ExtractorMiddleware";
import FileSupportPlugin from "../src/main";
import {
  LazyPairResolver,
  splitFilePath,
} from "../src/metadata/LazyPairResolver";
import { createDefaultSettings } from "../src/settings/PluginSettings";
import type {
  ContentExtractorAdapter,
  FileTypeConfig,
  PluginSettings,
} from "../src/types/contracts";
import { SupportedFileView } from "../src/views/SupportedFileView";

interface InMemoryExtractorVaultEnv {
  app: any;
  files: Map<string, TFile>;
  contents: Map<string, string>;
  frontmatters: Map<string, Record<string, any>>;
  addFile: (
    path: string,
    frontmatter?: Record<string, any>,
    content?: string
  ) => TFile;
  setFileContent: (path: string, content: string) => void;
  getFileContent: (path: string) => string;
}

function serializeMockYamlFrontmatter(
  fm: Record<string, any>,
  eol: "\r\n" | "\n" = "\n"
): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(fm)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${String(item)}`);
        }
      }
    } else if (typeof value === "string") {
      const needsQuotes =
        value.includes("[[") || value.includes(":") || value.includes("#");
      lines.push(`${key}: ${needsQuotes ? JSON.stringify(value) : value}`);
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  lines.push("---", "");
  return lines.join(eol);
}

function createInMemoryExtractorVaultEnv(): InMemoryExtractorVaultEnv {
  const app = createMockApp() as any;
  const files = new Map<string, TFile>();
  const contents = new Map<string, string>();
  const frontmatters = new Map<string, Record<string, any>>();

  const syncTFileProps = (file: TFile, newPath: string) => {
    const parts = splitFilePath(newPath);
    file.path = parts.path;
    file.name = parts.name;
    file.basename = parts.basename;
    file.extension = parts.extension;
  };

  const addFile = (
    path: string,
    frontmatter?: Record<string, any>,
    content: string = ""
  ): TFile => {
    const norm = normalizePath(path);
    const file = createMockTFile(norm);
    files.set(norm, file);
    contents.set(norm, content);
    if (frontmatter) {
      frontmatters.set(norm, { ...frontmatter });
    }
    return file;
  };

  const setFileContent = (path: string, content: string): void => {
    contents.set(normalizePath(path), content);
  };

  const getFileContent = (path: string): string => {
    return contents.get(normalizePath(path)) ?? "";
  };

  app.vault.getAbstractFileByPath = vi.fn((path: string) => {
    return files.get(normalizePath(path)) ?? null;
  });

  app.vault.read = vi.fn(async (file: TFile) => {
    return contents.get(normalizePath(file.path)) ?? "";
  });

  app.vault.modify = vi.fn(async (file: TFile, data: string) => {
    contents.set(normalizePath(file.path), data);
    app.vault.trigger("modify", file);
  });

  app.vault.process = vi.fn(
    async (file: TFile, fn: (data: string) => string) => {
      const current = await app.vault.read(file);
      const next = fn(current);
      if (next !== current) {
        await app.vault.modify(file, next);
      }
      return next;
    }
  );

  app.vault.create = vi.fn(async (path: string, data: string) => {
    const norm = normalizePath(path);
    const file = createMockTFile(norm);
    files.set(norm, file);
    contents.set(norm, data);
    app.vault.trigger("create", file);
    return file;
  });

  app.vault.delete = vi.fn(async (file: TFile) => {
    const norm = normalizePath(file.path);
    files.delete(norm);
    contents.delete(norm);
    frontmatters.delete(norm);
    app.vault.trigger("delete", file);
    app.metadataCache.trigger("deleted", file);
  });

  app.vault.rename = vi.fn(async (file: TFile, newPath: string) => {
    const oldPath = normalizePath(file.path);
    const normNew = normalizePath(newPath);
    files.delete(oldPath);
    const oldContent = contents.get(oldPath) ?? "";
    contents.delete(oldPath);
    const oldFm = frontmatters.get(oldPath);
    frontmatters.delete(oldPath);

    syncTFileProps(file, normNew);
    files.set(normNew, file);
    contents.set(normNew, oldContent);
    if (oldFm) {
      frontmatters.set(normNew, oldFm);
    }
    app.vault.trigger("rename", file, oldPath);
  });

  app.fileManager.renameFile = vi.fn(async (file: TFile, newPath: string) => {
    await app.vault.rename(file, newPath);
  });

  app.metadataCache.getFileCache = vi.fn((file: TFile) => {
    if (!file) return null;
    const norm = normalizePath(file.path);
    const fm = frontmatters.get(norm);
    if (fm) {
      return { frontmatter: { ...fm } };
    }
    if (files.has(norm)) {
      return {};
    }
    return null;
  });

  app.fileManager.processFrontMatter = vi.fn(
    async (file: TFile, fn: (fm: Record<string, any>) => void) => {
      const norm = normalizePath(file.path);
      const current = frontmatters.get(norm)
        ? { ...frontmatters.get(norm)! }
        : {};
      fn(current);
      frontmatters.set(norm, current);

      // Also synchronize the serialized YAML frontmatter block in the underlying file text
      const existingContent = contents.get(norm) ?? "";
      const eol = detectLineEnding(existingContent);
      const { bodyContent } = splitMarkdownFrontmatterAndBody(existingContent);
      const serializedFm = serializeMockYamlFrontmatter(current, eol);
      contents.set(norm, serializedFm + bodyContent);
      app.metadataCache.trigger("changed", file);
    }
  );

  return {
    app,
    files,
    contents,
    frontmatters,
    addFile,
    setFileContent,
    getFileContent,
  };
}

describe("ExtractorRegistry & NoOpPassthroughExtractor", () => {
  beforeEach(() => {
    Notice.clear();
  });

  it("registers NoOpPassthroughExtractor by default and resolves adapters by both explicit extractorId and supports(file, config)", async () => {
    const registry = new ExtractorRegistry();
    const fileTypeRegistry = new FileTypeRegistry();

    expect(registry.has(DEFAULT_EXTRACTOR_ID)).toBe(true);
    expect(registry.get(DEFAULT_EXTRACTOR_ID)).toBeInstanceOf(
      NoOpPassthroughExtractor
    );
    expect(PassthroughExtractor).toBe(NoOpPassthroughExtractor);

    const logFile = createMockTFile("logs/server.log");
    const cFile = createMockTFile("src/main.c");
    const logConfig = fileTypeRegistry.get("log")!;
    const cConfig = fileTypeRegistry.get("c")!;

    // 1. Default resolution returns NoOpPassthroughExtractor
    const defaultResolved = registry.resolve(logFile, logConfig);
    expect(defaultResolved?.id).toBe(DEFAULT_EXTRACTOR_ID);
    const defaultResult = await defaultResolved!.extract(
      logFile,
      createMockApp() as any
    );
    expect(defaultResult).toEqual({
      markdownBody: "",
      skipBodyUpdate: true,
    });

    // 2. Register an extension-based adapter via supports(file, config) without changing config.extractorId
    const logAdapter: ContentExtractorAdapter = {
      id: "log-summary",
      supports: (file, cfg) =>
        file.extension === "log" || cfg.extension === "log",
      extract: async () => ({
        markdownBody: "Extracted log summary",
      }),
    };
    registry.register(logAdapter);

    // Even though logConfig.extractorId is still "passthrough", logAdapter matches via supports()
    expect(registry.resolve(logFile, logConfig)).toBe(logAdapter);
    // While main.c still resolves to NoOpPassthroughExtractor
    expect(registry.resolve(cFile, cConfig)?.id).toBe(DEFAULT_EXTRACTOR_ID);

    // 3. Register a second adapter and select it explicitly via config.extractorId
    const customOcrAdapter: ContentExtractorAdapter = {
      id: "ocr-engine",
      supports: (_file, cfg) => cfg.extractorId === "ocr-engine",
      extract: async () => ({
        markdownBody: "OCR text",
      }),
    };
    registry.register(customOcrAdapter);

    const logWithExplicitId: FileTypeConfig = {
      ...logConfig,
      extractorId: "ocr-engine",
    };
    expect(registry.resolve(logFile, logWithExplicitId)).toBe(customOcrAdapter);

    // 3.5. Explicit "noop" and "none" aliases resolve to NoOpPassthroughExtractor (even when logAdapter is registered)
    expect(registry.has(NOOP_EXTRACTOR_ID)).toBe(true);
    expect(registry.has(NONE_EXTRACTOR_ID)).toBe(true);
    expect(registry.get(NOOP_EXTRACTOR_ID)).toBeInstanceOf(
      NoOpPassthroughExtractor
    );
    expect(registry.get(NONE_EXTRACTOR_ID)).toBeInstanceOf(
      NoOpPassthroughExtractor
    );
    expect(
      registry.resolve(logFile, { ...logConfig, extractorId: NOOP_EXTRACTOR_ID })
    ).toBeInstanceOf(NoOpPassthroughExtractor);
    expect(
      registry.resolve(logFile, { ...logConfig, extractorId: NONE_EXTRACTOR_ID })
    ).toBeInstanceOf(NoOpPassthroughExtractor);

    // 4. Unknown explicit extractorId resolves to undefined (does not silently run an unrelated adapter)
    const logWithUnknownId: FileTypeConfig = {
      ...logConfig,
      extractorId: "non-existent-extractor",
    };
    expect(registry.resolve(logFile, logWithUnknownId)).toBeUndefined();

    // 5. Disabled file type config resolves to undefined
    expect(
      registry.resolve(logFile, { ...logConfig, enabled: false })
    ).toBeUndefined();

    // 6. Validation on invalid adapter registration
    expect(() => registry.register({} as any)).toThrow(/non-empty string id/);
    expect(() =>
      registry.register({ id: "bad-1", extract: async () => ({ markdownBody: "" }) } as any)
    ).toThrow(/supports/);
    expect(() =>
      registry.register({ id: "bad-2", supports: () => true } as any)
    ).toThrow(/extract/);

    // 7. Unregister custom adapter
    expect(registry.unregister("log-summary")).toBe(true);
    expect(registry.resolve(logFile, logConfig)?.id).toBe(DEFAULT_EXTRACTOR_ID);
  });

  it("ensures NoOpPassthroughExtractor never overwrites user-authored YAML frontmatter or manual Markdown notes", async () => {
    const env = createInMemoryExtractorVaultEnv();
    const settings: PluginSettings = {
      ...createDefaultSettings(),
      enableMetadataFiles: true,
      metadataDirRegex: ".*",
    };
    const fileTypeRegistry = new FileTypeRegistry();
    const pairResolver = new LazyPairResolver(
      env.app,
      () => settings,
      fileTypeRegistry
    );
    const extractorRegistry = new ExtractorRegistry();
    const bus = new EventBus();
    const middleware = new ExtractorMiddleware(
      env.app,
      extractorRegistry,
      fileTypeRegistry,
      pairResolver
    );
    middleware.register(bus);

    const logFile = env.addFile(
      "logs/server.log",
      undefined,
      "2026-11-15 INFO Booted"
    );
    const userMarkdown = [
      "---",
      'file-support-target: "[[server.log]]"',
      "author: Simeon",
      "tags:",
      "  - file-metadata",
      "  - hand-curated",
      "---",
      "",
      "# Investigation Notes",
      "",
      "These user-written notes must never be overwritten by the default passthrough extractor.",
      "",
    ].join("\n");

    const companionMd = env.addFile(
      "logs/server.md",
      {
        "file-support-target": "[[server.log]]",
        author: "Simeon",
        tags: ["file-metadata", "hand-curated"],
      },
      userMarkdown
    );

    const payload = await bus.emit("metadata:extract", {
      app: env.app,
      targetFile: logFile,
      companionFile: companionMd,
    });

    expect(payload.result).toEqual({
      markdownBody: "",
      skipBodyUpdate: true,
    });
    expect(env.app.vault.modify).not.toHaveBeenCalled();
    expect(env.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    expect(env.getFileContent("logs/server.md")).toBe(userMarkdown);

    middleware.destroy();
  });
});

describe("Structured Managed Markdown Section Updater", () => {
  it.each([
    {
      name: "closes an unfinished user backtick fence before appending",
      existingMarkdown: [
        "---",
        'file-support-target: "[[server.log]]"',
        "---",
        "User notes",
        "```typescript",
        "const unfinished = true;",
        "",
      ].join("\r\n"),
      extractedBody: "Summary",
      expectedBody: "Summary",
      preservedText: "const unfinished = true;",
      expectedClosingText: "const unfinished = true;\r\n```\r\n\r\n",
    },
    {
      name: "does not treat a four-space-indented fence as a fenced block",
      existingMarkdown: [
        "User notes",
        "    ```literal",
        EXTRACTED_SECTION_START_MARKER,
        "Old extraction",
        EXTRACTED_SECTION_END_MARKER,
        "Keep this note",
        "",
      ].join("\r\n"),
      extractedBody: "Updated extraction",
      expectedBody: "Updated extraction",
      preservedText: "Keep this note",
      expectedClosingText: "",
    },
    {
      name: "recognizes tilde fences whose info string contains tildes",
      existingMarkdown: [
        "User notes",
        "~~~language~~~",
        "Unfinished tilde fence",
        "",
      ].join("\r\n"),
      extractedBody: "Summary",
      expectedBody: "Summary",
      preservedText: "Unfinished tilde fence",
      expectedClosingText: "Unfinished tilde fence\r\n~~~\r\n\r\n",
    },
    {
      name: "keeps an extracted unclosed fence inside its managed block",
      existingMarkdown: "Manual note\r\n",
      extractedBody: "```typescript\r\nconst useful = true;\r\n",
      expectedBody: "```typescript\r\nconst useful = true;",
      preservedText: "Manual note",
      expectedClosingText: "",
    },
    {
      name: "neutralizes extracted delimiter lines without losing their text",
      existingMarkdown: "Manual note\r\n",
      extractedBody: [
        "~~~yaml~info",
        EXTRACTED_SECTION_START_MARKER,
        "Useful extracted text",
        EXTRACTED_SECTION_END_MARKER,
      ].join("\r\n"),
      expectedBody: [
        "~~~yaml~info",
        EXTRACTED_SECTION_START_MARKER.replace("<!--", "&lt;!--"),
        "Useful extracted text",
        EXTRACTED_SECTION_END_MARKER.replace("<!--", "&lt;!--"),
      ].join("\r\n"),
      preservedText: "Manual note",
      expectedClosingText: "",
    },
  ])("is stable across three applications: $name", ({
    existingMarkdown,
    extractedBody,
    expectedBody,
    preservedText,
    expectedClosingText,
  }) => {
    let updated = existingMarkdown;

    for (let application = 0; application < 3; application++) {
      updated = updateExtractedMarkdownSection(updated, extractedBody);

      expect(updated.split(EXTRACTED_SECTION_START_MARKER).length - 1).toBe(1);
      expect(updated.split(EXTRACTED_SECTION_END_MARKER).length - 1).toBe(1);
      expect(hasExtractedMarkdownSection(updated)).toBe(true);
      expect(readExtractedMarkdownSection(updated)).toBe(expectedBody);
      expect(updated).toContain(preservedText);
      expect(updated.replace(/\r\n/g, "").includes("\n")).toBe(false);

      if (expectedClosingText) {
        expect(updated).toContain(
          `${expectedClosingText}${EXTRACTED_SECTION_START_MARKER}`
        );
      }
    }
  });

  it("inserts, updates, and reads the managed block idempotently while preserving YAML frontmatter, manual notes, and $-tokens", () => {
    const initialCompanionDoc = [
      "---",
      'file-support-target: "[[app.c]]"',
      "tags:",
      "  - file-metadata",
      "---",
      "",
      "",
    ].join("\n");

    expect(hasExtractedMarkdownSection(initialCompanionDoc)).toBe(false);
    expect(readExtractedMarkdownSection(initialCompanionDoc)).toBeNull();

    // 1. Insert managed block into a newly created companion note
    const extractedV1 = "## Symbols\n- `int main(int argc, char **argv)`";
    const afterFirstInsert = updateExtractedMarkdownSection(
      initialCompanionDoc,
      extractedV1
    );

    expect(hasExtractedMarkdownSection(afterFirstInsert)).toBe(true);
    expect(readExtractedMarkdownSection(afterFirstInsert)).toBe(extractedV1);
    expect(afterFirstInsert.startsWith("---\nfile-support-target:")).toBe(true);
    expect(afterFirstInsert).toContain(EXTRACTED_SECTION_START_MARKER);
    expect(afterFirstInsert).toContain(EXTRACTED_SECTION_END_MARKER);

    // 2. Idempotency: calling updateExtractedMarkdownSection again with identical content returns exact same string
    const afterDuplicateInsert = updateExtractedMarkdownSection(
      afterFirstInsert,
      extractedV1
    );
    expect(afterDuplicateInsert).toBe(afterFirstInsert);

    // 3. User adds manual notes BOTH above and below the managed block
    const docWithUserNotes = [
      "---",
      'file-support-target: "[[app.c]]"',
      "reviewer: Alice",
      "tags:",
      "  - file-metadata",
      "---",
      "",
      "# Manual Architecture Notes",
      "Entry point is in `main`.",
      "",
      EXTRACTED_SECTION_START_MARKER,
      extractedV1,
      EXTRACTED_SECTION_END_MARKER,
      "",
      "## Manual Follow-up",
      "- [ ] Add signal handler",
      "",
    ].join("\n");

    // 4. Update with content containing special regex replacement tokens ($&, $', $`, $1, $$)
    const extractedWithDollarTokens = [
      "## Symbols & Regexes",
      "- Pattern: `s/foo/$&/g` and `$1` and `$$` and `$'` and ``$` ``",
    ].join("\n");

    const afterUpdate = updateExtractedMarkdownSection(
      docWithUserNotes,
      extractedWithDollarTokens
    );

    expect(readExtractedMarkdownSection(afterUpdate)).toBe(
      extractedWithDollarTokens
    );
    expect(afterUpdate).toContain("reviewer: Alice");
    expect(afterUpdate).toContain(
      "# Manual Architecture Notes\nEntry point is in `main`."
    );
    expect(afterUpdate).toContain("## Manual Follow-up\n- [ ] Add signal handler");
    // Ensure only one start and one end marker exist
    expect(
      afterUpdate.split(EXTRACTED_SECTION_START_MARKER).length - 1
    ).toBe(1);
    expect(afterUpdate.split(EXTRACTED_SECTION_END_MARKER).length - 1).toBe(1);

    // 5. Appending managed block to a companion note that already had manual notes but no block yet
    const manualOnlyDoc = [
      "---",
      'file-support-target: "[[script.rb]]"',
      "---",
      "",
      "# Ruby Script Notes",
      "Written manually before any extractor ran.",
    ].join("\n");

    const appendedDoc = updateExtractedMarkdownSection(
      manualOnlyDoc,
      "Class: `Worker`"
    );
    expect(appendedDoc).toContain(
      "# Ruby Script Notes\nWritten manually before any extractor ran."
    );
    expect(readExtractedMarkdownSection(appendedDoc)).toBe("Class: `Worker`");
    expect(
      updateExtractedMarkdownSection(appendedDoc, "Class: `Worker`")
    ).toBe(appendedDoc);

    // 6. Safely handles a stray unmatched start marker in user prose without swallowing user prose
    const docWithStrayMarker = [
      "---",
      'file-support-target: "[[server.log]]"',
      "---",
      "",
      "# User Notes",
      EXTRACTED_SECTION_START_MARKER,
      "Paragraph written by user after an accidental stray start marker.",
      "",
      EXTRACTED_SECTION_START_MARKER,
      "Old extracted block",
      EXTRACTED_SECTION_END_MARKER,
    ].join("\n");

    const repairedDoc = updateExtractedMarkdownSection(
      docWithStrayMarker,
      "New extracted block"
    );
    expect(repairedDoc).toContain(
      "Paragraph written by user after an accidental stray start marker."
    );
    expect(readExtractedMarkdownSection(repairedDoc)).toBe(
      "New extracted block"
    );
  });

  it("ignores managed markers inside user fenced code blocks (``` and ~~~) and inline prose without overwriting user fences", () => {
    const docWithFencedMarkers = [
      "---",
      'file-support-target: "[[plugin.js]]"',
      "---",
      "# Plugin Documentation",
      "Inline example: `<!-- file-support:extracted:start -->` and `<!-- file-support:extracted:end -->` on one line.",
      "",
      "```markdown",
      EXTRACTED_SECTION_START_MARKER,
      "This example block inside a backtick code fence MUST NOT be overwritten!",
      EXTRACTED_SECTION_END_MARKER,
      "```",
      "",
      "~~~html",
      EXTRACTED_SECTION_START_MARKER,
      "This example block inside a tilde code fence MUST NOT be overwritten either!",
      EXTRACTED_SECTION_END_MARKER,
      "~~~",
      "",
      "User concluding paragraph.",
    ].join("\n");

    // 1. Neither fenced block nor inline markers should be detected as an active managed block
    expect(hasExtractedMarkdownSection(docWithFencedMarkers)).toBe(false);
    expect(readExtractedMarkdownSection(docWithFencedMarkers)).toBeNull();

    // 2. First extraction appends a real standalone managed block at the end without touching the fences
    const afterFirstExtract = updateExtractedMarkdownSection(
      docWithFencedMarkers,
      "Extracted AST: `export function init()`"
    );

    expect(afterFirstExtract).toContain(
      [
        "```markdown",
        EXTRACTED_SECTION_START_MARKER,
        "This example block inside a backtick code fence MUST NOT be overwritten!",
        EXTRACTED_SECTION_END_MARKER,
        "```",
      ].join("\n")
    );
    expect(afterFirstExtract).toContain(
      [
        "~~~html",
        EXTRACTED_SECTION_START_MARKER,
        "This example block inside a tilde code fence MUST NOT be overwritten either!",
        EXTRACTED_SECTION_END_MARKER,
        "~~~",
      ].join("\n")
    );
    expect(afterFirstExtract).toContain("User concluding paragraph.");
    expect(hasExtractedMarkdownSection(afterFirstExtract)).toBe(true);
    expect(readExtractedMarkdownSection(afterFirstExtract)).toBe(
      "Extracted AST: `export function init()`"
    );

    // 3. Subsequent extraction updates ONLY the standalone managed block at the bottom, leaving fenced examples intact
    const afterSecondExtract = updateExtractedMarkdownSection(
      afterFirstExtract,
      "Extracted AST v2: `export function run()`"
    );
    expect(afterSecondExtract).toContain(
      "This example block inside a backtick code fence MUST NOT be overwritten!"
    );
    expect(afterSecondExtract).toContain(
      "This example block inside a tilde code fence MUST NOT be overwritten either!"
    );
    expect(readExtractedMarkdownSection(afterSecondExtract)).toBe(
      "Extracted AST v2: `export function run()`"
    );
    expect(
      updateExtractedMarkdownSection(
        afterSecondExtract,
        "Extracted AST v2: `export function run()`"
      )
    ).toBe(afterSecondExtract);
  });

  it("preserves CRLF (\\r\\n) line endings, immediate post-frontmatter text, trailing spaces, and trailing blank lines verbatim", async () => {
    // 1. Companion document using CRLF (\r\n), no blank line after frontmatter, trailing spaces, and multiple trailing blank lines
    const crlfDocWithoutBlock = [
      "---",
      'file-support-target: "[[win.log]]"',
      "---",
      "# Windows Log Notes immediately after frontmatter",
      "Line with intentional trailing spaces   ",
      "",
      "",
    ].join("\r\n");

    const insertedCrlf = updateExtractedMarkdownSection(
      crlfDocWithoutBlock,
      "Line 1\nLine 2"
    );

    // Every single original byte of crlfDocWithoutBlock must be preserved as prefix
    expect(insertedCrlf.startsWith(crlfDocWithoutBlock)).toBe(true);
    // No bare LF (\n not preceded by \r) anywhere in the document
    expect(insertedCrlf.replace(/\r\n/g, "").includes("\n")).toBe(false);
    expect(readExtractedMarkdownSection(insertedCrlf)).toBe(
      "Line 1\r\nLine 2"
    );

    // Calling again with identical content is byte-for-byte identical
    expect(updateExtractedMarkdownSection(insertedCrlf, "Line 1\nLine 2")).toBe(
      insertedCrlf
    );
    expect(
      updateExtractedMarkdownSection(insertedCrlf, "Line 1\r\nLine 2")
    ).toBe(insertedCrlf);

    // 2. End-to-end middleware refresh on a CRLF companion note skips vault.modify when content is unchanged
    const env = createInMemoryExtractorVaultEnv();
    const plugin = new FileSupportPlugin(env.app, createMockManifest());
    await plugin.onload();
    plugin.settings.enableMetadataFiles = true;
    await plugin.saveSettings();

    plugin.extractorRegistry.register({
      id: "crlf-log-extractor",
      supports: (f) => f.extension === "log",
      extract: async () => ({
        markdownBody: "Line 1\nLine 2",
      }),
    });

    const logFile = env.addFile("logs/win.log", undefined, "OK\r\n");
    env.addFile(
      "logs/win.md",
      { "file-support-target": "[[win.log]]" },
      insertedCrlf
    );

    env.app.vault.modify.mockClear();
    await plugin.refreshExtractedMetadataForFile(logFile);
    // Because CRLF was preserved, updatedContent === currentContent and vault.modify is NOT called!
    expect(env.app.vault.modify).not.toHaveBeenCalled();
    expect(env.getFileContent("logs/win.md")).toBe(insertedCrlf);

    await plugin.onunload();
  });
});

describe("End-to-End Companion Creation, Extractor Execution, Refresh Triggers & Concurrency", () => {
  beforeEach(() => {
    Notice.clear();
  });

  it("automatically runs registered extractor on companion creation and refreshes via command palette, context menu, and view header action", async () => {
    const env = createInMemoryExtractorVaultEnv();
    const plugin = new FileSupportPlugin(env.app, createMockManifest());
    await plugin.onload();

    // Enable companion metadata notes for `^logs`
    plugin.settings.enableMetadataFiles = true;
    plugin.settings.metadataDirRegex = "^logs";
    await plugin.saveSettings();

    // Register a custom log extractor that summarizes line/error counts and sets frontmatter properties
    const extractSpy = vi.fn(async (file: TFile, app: any) => {
      const text = await app.vault.read(file);
      const lines = text.split("\n").filter((l: string) => l.trim().length > 0);
      const errorLines = lines.filter((l: string) => l.includes("ERROR"));
      return {
        markdownBody: [
          "### Extracted Log Summary",
          `- Total lines: ${lines.length}`,
          `- Error count: ${errorLines.length}`,
          ...errorLines.map((e: string) => `  - \`${e}\``),
        ].join("\n"),
        frontmatterProps: {
          "log-lines": lines.length,
          "log-errors": errorLines.length,
          tags: ["extracted-log"],
        },
      };
    });

    plugin.extractorRegistry.register({
      id: "log-analyzer",
      supports: (file) => file.extension === "log",
      extract: extractSpy,
    });

    const logFile = env.addFile(
      "logs/service.log",
      undefined,
      ["2026-11-15 INFO Starting", "2026-11-15 ERROR Connection refused"].join(
        "\n"
      )
    );
    const ineligibleFile = env.addFile(
      "src/main.c",
      undefined,
      "int main() { return 0; }"
    );

    const refreshCommand = (plugin as any)._commands.find(
      (c: any) => c.id === REFRESH_EXTRACTED_METADATA_COMMAND_ID
    );
    expect(refreshCommand).toBeDefined();
    expect(refreshCommand.name).toBe(REFRESH_EXTRACTED_METADATA_TITLE);

    // 1. Before companion note exists:
    // - Refresh command checkCallback(true) is false because no companion note exists yet
    env.app.workspace.getActiveFile = vi.fn(() => logFile);
    expect(refreshCommand.checkCallback(true)).toBe(false);

    // - SupportedFileView header refresh button is disabled before companion exists
    const view = new SupportedFileView(createMockLeaf(), plugin);
    view.onload();
    await view.onLoadFile(logFile);
    const refreshHeaderBtn = view.getRefreshMetadataActionElement()!;
    expect(refreshHeaderBtn).toBeDefined();
    expect(refreshHeaderBtn.classList.contains("is-disabled")).toBe(true);
    expect(refreshHeaderBtn.getAttribute("aria-disabled")).toBe("true");

    // Clicking the header refresh button when no companion exists yet shows a feedback Notice
    Notice.clear();
    refreshHeaderBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(Notice.instances.length).toBe(1);
    expect(Notice.instances[0].message).toContain(
      'No companion metadata note exists for "service.log"'
    );

    // 2. Create companion note externally via openOrCreateCompanionForFile (autoRunExtractorOnCreate = true)
    const companionFile = await plugin.openOrCreateCompanionForFile(logFile);
    expect(companionFile).not.toBeNull();
    expect(companionFile?.path).toBe("logs/service.md");
    expect(extractSpy).toHaveBeenCalledTimes(1);

    // Verify both YAML frontmatter and managed Markdown block were populated on creation in the single file
    expect(env.frontmatters.get("logs/service.md")).toEqual({
      "file-support-target": "[[service.log]]",
      "log-lines": 2,
      "log-errors": 1,
      tags: ["file-metadata", "extracted-log"],
    });
    expect(env.getFileContent("logs/service.md")).toContain("log-lines: 2");
    expect(env.getFileContent("logs/service.md")).toContain("log-errors: 1");
    expect(
      readExtractedMarkdownSection(env.getFileContent("logs/service.md"))
    ).toBe(
      [
        "### Extracted Log Summary",
        "- Total lines: 2",
        "- Error count: 1",
        "  - `2026-11-15 ERROR Connection refused`",
      ].join("\n")
    );

    // SupportedFileView automatically updates its header refresh button to enabled WITHOUT reloading the view!
    await new Promise((r) => setTimeout(r, 10));
    expect(refreshHeaderBtn.classList.contains("is-disabled")).toBe(false);
    expect(refreshHeaderBtn.getAttribute("aria-disabled")).toBe("false");

    // 3. User edits `logs/service.md` to add custom frontmatter & manual notes above and below the managed block
    const currentCompanionText = env.getFileContent("logs/service.md");
    const enrichedWithUserNotes =
      currentCompanionText.replace(
        EXTRACTED_SECTION_START_MARKER,
        `# Incident Postmortem\nInvestigating outage.\n\n${EXTRACTED_SECTION_START_MARKER}`
      ) + "\n## Next Steps\n- Increase retry backoff\n";
    env.setFileContent("logs/service.md", enrichedWithUserNotes);
    env.frontmatters.set("logs/service.md", {
      ...env.frontmatters.get("logs/service.md")!,
      owner: "DevOps",
    });

    // 4. Target file `logs/service.log` receives new log entries
    env.setFileContent(
      "logs/service.log",
      [
        "2026-11-15 INFO Starting",
        "2026-11-15 ERROR Connection refused",
        "2026-11-15 ERROR Timeout after 30s",
        "2026-11-15 INFO Recovered",
      ].join("\n")
    );

    // 5. Trigger refresh via Command Palette while focused on the companion `.md` note (`logs/service.md`)
    env.app.workspace.getActiveFile = vi.fn(() => companionFile);
    expect(refreshCommand.checkCallback(true)).toBe(true);
    expect(refreshCommand.checkCallback(false)).toBe(true);
    await new Promise((r) => setTimeout(r, 15));

    expect(extractSpy).toHaveBeenCalledTimes(2);
    const updatedAfterCmd = env.getFileContent("logs/service.md");
    expect(readExtractedMarkdownSection(updatedAfterCmd)).toBe(
      [
        "### Extracted Log Summary",
        "- Total lines: 4",
        "- Error count: 2",
        "  - `2026-11-15 ERROR Connection refused`",
        "  - `2026-11-15 ERROR Timeout after 30s`",
      ].join("\n")
    );
    // User's manual notes above and below and custom YAML properties are intact!
    expect(updatedAfterCmd).toContain(
      "# Incident Postmortem\nInvestigating outage."
    );
    expect(updatedAfterCmd).toContain(
      "## Next Steps\n- Increase retry backoff"
    );
    expect(env.frontmatters.get("logs/service.md")).toEqual({
      "file-support-target": "[[service.log]]",
      owner: "DevOps",
      "log-lines": 4,
      "log-errors": 2,
      tags: ["file-metadata", "extracted-log"],
    });

    // 6. Trigger refresh via File Explorer context menu (`file-menu`) on the companion `.md` note
    env.setFileContent(
      "logs/service.log",
      "2026-11-15 INFO Clean restart\n2026-11-15 INFO Healthy"
    );
    const companionMenu = new Menu();
    env.app.workspace.trigger(
      "file-menu",
      companionMenu,
      companionFile,
      "file-explorer"
    );
    expect(companionMenu.items.length).toBe(1);
    expect(companionMenu.items[0].title).toBe(REFRESH_EXTRACTED_METADATA_TITLE);
    companionMenu.items[0].triggerClick();
    await new Promise((r) => setTimeout(r, 15));

    expect(extractSpy).toHaveBeenCalledTimes(3);
    expect(
      readExtractedMarkdownSection(env.getFileContent("logs/service.md"))
    ).toBe(
      [
        "### Extracted Log Summary",
        "- Total lines: 2",
        "- Error count: 0",
      ].join("\n")
    );
    expect(env.frontmatters.get("logs/service.md")?.["log-errors"]).toBe(0);

    // 7. Trigger refresh via SupportedFileView header button
    env.setFileContent(
      "logs/service.log",
      "2026-11-15 ERROR Disk full"
    );
    refreshHeaderBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 15));

    expect(extractSpy).toHaveBeenCalledTimes(4);
    expect(
      readExtractedMarkdownSection(env.getFileContent("logs/service.md"))
    ).toContain("- Error count: 1");

    // 8. Ineligible file (`src/main.c` outside `^logs`) disables refresh command
    env.app.workspace.getActiveViewOfType = vi.fn(() => null);
    env.app.workspace.getActiveFile = vi.fn(() => ineligibleFile);
    expect(refreshCommand.checkCallback(true)).toBe(false);

    // 9. Deleting the companion note externally automatically disables the open SupportedFileView's header refresh button
    await env.app.vault.delete(companionFile!);
    await new Promise((r) => setTimeout(r, 10));
    expect(refreshHeaderBtn.classList.contains("is-disabled")).toBe(true);
    expect(refreshHeaderBtn.getAttribute("aria-disabled")).toBe("true");

    view.onunload();
    await plugin.onunload();
  });

  it("respects autoRunExtractorOnCreate = false on companion creation while allowing on-demand refresh later", async () => {
    const env = createInMemoryExtractorVaultEnv();
    const plugin = new FileSupportPlugin(env.app, createMockManifest());
    await plugin.onload();

    plugin.settings.enableMetadataFiles = true;
    plugin.settings.autoRunExtractorOnCreate = false;
    await plugin.saveSettings();

    const extractSpy = vi.fn(async () => ({
      markdownBody: "Extracted on demand",
    }));
    plugin.extractorRegistry.register({
      id: "json-extractor",
      supports: (file) => file.extension === "json",
      extract: extractSpy,
    });

    const jsonFile = env.addFile(
      "config/settings.json",
      undefined,
      '{"port": 8080}'
    );

    // 1. Creating companion note with autoRunExtractorOnCreate = false does NOT invoke extractor
    const companion = await plugin.openOrCreateCompanionForFile(jsonFile);
    expect(companion?.path).toBe("config/settings.md");
    expect(extractSpy).not.toHaveBeenCalled();
    expect(
      hasExtractedMarkdownSection(env.getFileContent("config/settings.md"))
    ).toBe(false);

    // 2. Running refreshExtractedMetadataForFile populates the managed block on demand
    const result = await plugin.refreshExtractedMetadataForFile(jsonFile);
    expect(result?.markdownBody).toBe("Extracted on demand");
    expect(extractSpy).toHaveBeenCalledTimes(1);
    expect(
      readExtractedMarkdownSection(env.getFileContent("config/settings.md"))
    ).toBe("Extracted on demand");

    await plugin.onunload();
  });

  it("serializes concurrent metadata:extract refreshes per companion file without race conditions or duplicate blocks", async () => {
    const env = createInMemoryExtractorVaultEnv();
    const plugin = new FileSupportPlugin(env.app, createMockManifest());
    await plugin.onload();

    plugin.settings.enableMetadataFiles = true;
    await plugin.saveSettings();

    let callCount = 0;
    plugin.extractorRegistry.register({
      id: "async-slow-extractor",
      supports: (file) => file.extension === "log",
      extract: async (file, app) => {
        const currentCall = ++callCount;
        const text = await app.vault.read(file);
        if (currentCall === 1) {
          // Simulate target file changing while Run #1 is still in flight
          env.setFileContent("logs/race.log", "v2");
          await new Promise((r) => setTimeout(r, 30));
        } else {
          await new Promise((r) => setTimeout(r, 5));
        }
        return {
          markdownBody: `Run #${currentCall}: ${text}`,
          frontmatterProps: {
            lastRun: currentCall,
          },
        };
      },
    });

    const logFile = env.addFile("logs/race.log", undefined, "v1");
    const companionFile = env.addFile(
      "logs/race.md",
      { "file-support-target": "[[race.log]]" },
      [
        "---",
        'file-support-target: "[[race.log]]"',
        "---",
        "",
        "# Manual Header",
      ].join("\n")
    );

    // Fire two overlapping refreshes concurrently
    const p1 = plugin.refreshExtractedMetadataForFile(logFile);
    const p2 = plugin.refreshExtractedMetadataForFile(companionFile);

    const [res1, res2] = await Promise.all([p1, p2]);
    expect(res1?.markdownBody).toBe("Run #1: v1");
    expect(res2?.markdownBody).toBe("Run #2: v2");

    const finalDoc = env.getFileContent("logs/race.md");
    // Run #2 ran strictly after Run #1, so Run #2's result wins and there is only 1 managed block
    expect(readExtractedMarkdownSection(finalDoc)).toBe("Run #2: v2");
    expect(finalDoc).toContain("# Manual Header");
    expect(finalDoc.split(EXTRACTED_SECTION_START_MARKER).length - 1).toBe(1);
    expect(finalDoc.split(EXTRACTED_SECTION_END_MARKER).length - 1).toBe(1);
    expect(env.frontmatters.get("logs/race.md")?.lastRun).toBe(2);

    // Firing two identical concurrent refreshes when content hasn't changed does not write to disk at all,
    // and when content changes to a new identical value across two concurrent refreshes, vault.modify is called only once!
    plugin.extractorRegistry.register({
      id: "async-slow-extractor",
      supports: (file) => file.extension === "log",
      extract: async () => ({
        markdownBody: "Run #2: v2",
      }),
    });
    env.app.vault.modify.mockClear();
    await Promise.all([
      plugin.refreshExtractedMetadataForFile(logFile),
      plugin.refreshExtractedMetadataForFile(logFile),
    ]);
    expect(env.app.vault.modify).not.toHaveBeenCalled();

    plugin.extractorRegistry.register({
      id: "async-slow-extractor",
      supports: (file) => file.extension === "log",
      extract: async () => ({
        markdownBody: "Identical concurrent v3",
      }),
    });
    env.app.vault.modify.mockClear();
    await Promise.all([
      plugin.refreshExtractedMetadataForFile(logFile),
      plugin.refreshExtractedMetadataForFile(logFile),
    ]);
    expect(env.app.vault.modify).toHaveBeenCalledTimes(1);
    expect(readExtractedMarkdownSection(env.getFileContent("logs/race.md"))).toBe(
      "Identical concurrent v3"
    );

    await plugin.onunload();
  });

  it("handles extractor errors, frontmatter failures, and vault.modify failures gracefully without corrupting user notes or deadlocking the queue", async () => {
    const env = createInMemoryExtractorVaultEnv();
    const plugin = new FileSupportPlugin(env.app, createMockManifest());
    await plugin.onload();

    plugin.settings.enableMetadataFiles = true;
    await plugin.saveSettings();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const logFile = env.addFile("logs/flaky.log", undefined, "INFO ok");
    const originalCompanionContent = [
      "---",
      'file-support-target: "[[flaky.log]]"',
      "---",
      "",
      "# Precious User Notes",
      "Must remain intact on failure.",
    ].join("\n");
    const companionFile = env.addFile(
      "logs/flaky.md",
      { "file-support-target": "[[flaky.log]]" },
      originalCompanionContent
    );

    // 1. Adapter extract() throws an error
    let shouldFailExtract = true;
    plugin.extractorRegistry.register({
      id: "flaky-extractor",
      supports: (file) => file.extension === "log",
      extract: async () => {
        if (shouldFailExtract) {
          throw new Error("OCR worker timed out");
        }
        return {
          markdownBody: "Recovered extraction output",
          frontmatterProps: { status: "recovered" },
        };
      },
    });

    Notice.clear();
    const failedResult = await plugin.refreshExtractedMetadataForFile(logFile);
    expect(failedResult).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    expect(Notice.instances.length).toBe(1);
    expect(Notice.instances[0].message).toContain("OCR worker timed out");
    expect(env.getFileContent("logs/flaky.md")).toBe(originalCompanionContent);

    // 2. Frontmatter update (processFrontMatter) throws an error
    shouldFailExtract = false;
    const baseProcessFrontMatter = env.app.fileManager.processFrontMatter;
    env.app.fileManager.processFrontMatter = vi.fn(async () => {
      throw new Error("YAML parse error: invalid frontmatter");
    });

    Notice.clear();
    const fmFailedResult =
      await plugin.refreshExtractedMetadataForFile(logFile);
    expect(fmFailedResult).toBeNull();
    expect(Notice.instances.length).toBe(1);
    expect(Notice.instances[0].message).toContain(
      "YAML parse error: invalid frontmatter"
    );
    expect(env.getFileContent("logs/flaky.md")).toBe(originalCompanionContent);
    env.app.fileManager.processFrontMatter = baseProcessFrontMatter;

    // 3. Vault modify throws a disk write error
    const baseModify = env.app.vault.modify;
    const contentBeforeModifyFailure = env.getFileContent("logs/flaky.md");
    env.app.vault.modify = vi.fn(async () => {
      throw new Error("ENOSPC: no space left on device");
    });

    Notice.clear();
    const writeFailedResult =
      await plugin.refreshExtractedMetadataForFile(logFile);
    expect(writeFailedResult).toBeNull();
    expect(Notice.instances.length).toBe(1);
    expect(Notice.instances[0].message).toContain("ENOSPC");
    expect(env.getFileContent("logs/flaky.md")).toContain(
      "# Precious User Notes\nMust remain intact on failure."
    );
    env.setFileContent("logs/flaky.md", contentBeforeModifyFailure);

    // 4. Subsequent refresh after restoring vault.modify succeeds (queue lock was properly released)
    env.app.vault.modify = baseModify;
    const recoveredResult =
      await plugin.refreshExtractedMetadataForFile(logFile);
    expect(recoveredResult?.markdownBody).toBe("Recovered extraction output");
    expect(
      readExtractedMarkdownSection(env.getFileContent("logs/flaky.md"))
    ).toBe("Recovered extraction output");
    expect(env.getFileContent("logs/flaky.md")).toContain(
      "# Precious User Notes\nMust remain intact on failure."
    );
    expect(env.getFileContent("logs/flaky.md")).toContain("status: recovered");
    expect(env.frontmatters.get("logs/flaky.md")?.status).toBe("recovered");

    warnSpy.mockRestore();
    await plugin.onunload();
  });

  it("uses vault.process atomic read-modify-write so interleaved user edits made while async extract() is running are never clobbered", async () => {
    const env = createInMemoryExtractorVaultEnv();
    const plugin = new FileSupportPlugin(env.app, createMockManifest());
    await plugin.onload();

    plugin.settings.enableMetadataFiles = true;
    await plugin.saveSettings();

    const logFile = env.addFile("logs/live.log", undefined, "2026-11-15 WARN Slow query");
    env.addFile(
      "logs/live.md",
      { "file-support-target": "[[live.log]]" },
      [
        "---",
        'file-support-target: "[[live.log]]"',
        "---",
        "",
        "# Live Session Notes",
        "Initial paragraph before extraction starts.",
        "",
        EXTRACTED_SECTION_START_MARKER,
        "Old extracted summary",
        EXTRACTED_SECTION_END_MARKER,
      ].join("\n")
    );

    plugin.extractorRegistry.register({
      id: "slow-live-extractor",
      supports: (f) => f.extension === "log",
      extract: async () => {
        // Simulate the user typing a new paragraph into the companion note while async extraction is running!
        const currentDoc = env.getFileContent("logs/live.md");
        const editedByUserWhileExtracting = currentDoc.replace(
          "Initial paragraph before extraction starts.",
          "Initial paragraph before extraction starts.\n\nInterleaved paragraph typed by user while extractor was running!"
        );
        env.setFileContent("logs/live.md", editedByUserWhileExtracting);

        await new Promise((r) => setTimeout(r, 15));
        return {
          markdownBody: "New extracted summary after slow async extraction",
          frontmatterProps: {
            extractedAt: "2026-11-15",
          },
        };
      },
    });

    const res = await plugin.refreshExtractedMetadataForFile(logFile);
    expect(res?.markdownBody).toBe(
      "New extracted summary after slow async extraction"
    );
    expect(env.app.vault.process).toHaveBeenCalledTimes(1);

    const finalCompanionText = env.getFileContent("logs/live.md");
    // Both the interleaved user edit AND the new extracted section AND the updated YAML frontmatter are present!
    expect(finalCompanionText).toContain(
      "Interleaved paragraph typed by user while extractor was running!"
    );
    expect(finalCompanionText).toContain("extractedAt: 2026-11-15");
    expect(readExtractedMarkdownSection(finalCompanionText)).toBe(
      "New extracted summary after slow async extraction"
    );

    await plugin.onunload();
  });
});
