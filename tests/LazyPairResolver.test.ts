import { beforeEach, describe, expect, it, vi } from "vitest";
import {
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
import FileSupportPlugin from "../src/main";
import {
  LazyPairResolver,
  doesFrontmatterLinkMatchTarget,
  extractWikiLinkTarget,
  formatTargetWikiLink,
  mergeFrontmatterTags,
  splitFilePath,
} from "../src/metadata/LazyPairResolver";
import { MetadataCompanionMiddleware } from "../src/middlewares/MetadataCompanionMiddleware";
import { createDefaultSettings } from "../src/settings/PluginSettings";
import type { PluginSettings } from "../src/types/contracts";
import { SupportedFileView } from "../src/views/SupportedFileView";

interface InMemoryVaultEnv {
  app: any;
  files: Map<string, TFile>;
  contents: Map<string, string>;
  frontmatters: Map<string, Record<string, any>>;
  addFile: (
    path: string,
    frontmatter?: Record<string, any>,
    content?: string
  ) => TFile;
  removeFile: (path: string) => TFile | undefined;
  renameTargetInVault: (file: TFile, newPath: string) => string;
}

function createInMemoryVaultEnv(): InMemoryVaultEnv {
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

  const removeFile = (path: string): TFile | undefined => {
    const norm = normalizePath(path);
    const existing = files.get(norm);
    files.delete(norm);
    contents.delete(norm);
    frontmatters.delete(norm);
    return existing;
  };

  // Simulate Obsidian's behavior where `file` is already at `newPath` and `oldPath` is missing from vault
  // when `vault.on("rename", file, oldPath)` triggers.
  const renameTargetInVault = (file: TFile, newPath: string): string => {
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
    return oldPath;
  };

  app.vault.getAbstractFileByPath = vi.fn((path: string) => {
    return files.get(normalizePath(path)) ?? null;
  });

  app.vault.read = vi.fn(async (file: TFile) => {
    return contents.get(normalizePath(file.path)) ?? "";
  });

  app.vault.modify = vi.fn(async (file: TFile, data: string) => {
    contents.set(normalizePath(file.path), data);
  });

  app.vault.create = vi.fn(async (path: string, data: string) => {
    const norm = normalizePath(path);
    const file = createMockTFile(norm);
    files.set(norm, file);
    contents.set(norm, data);
    return file;
  });

  app.vault.rename = vi.fn(async (file: TFile, newPath: string) => {
    const oldPath = renameTargetInVault(file, newPath);
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
      return { frontmatter: fm };
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
    }
  );

  return {
    app,
    files,
    contents,
    frontmatters,
    addFile,
    removeFile,
    renameTargetInVault,
  };
}

describe("LazyPairResolver & YAML Frontmatter Helpers", () => {
  beforeEach(() => {
    Notice.clear();
  });

  it("returns null when enableMetadataFiles is false (default) or directory does not match metadataDirRegex", () => {
    const env = createInMemoryVaultEnv();
    const logFile = env.addFile("logs/2026/server.log");
    const cFile = env.addFile("src/engine/main.c");
    const rootFile = env.addFile("root.log");

    const settings: PluginSettings = createDefaultSettings();
    // 1. Default: enableMetadataFiles is false
    expect(settings.enableMetadataFiles).toBe(false);

    const registry = new FileTypeRegistry();
    const resolver = new LazyPairResolver(env.app, () => settings, registry);

    expect(resolver.isMetadataEnabled()).toBe(false);
    expect(resolver.isTargetEligible(logFile)).toBe(false);
    expect(resolver.resolve(logFile)).toBeNull();
    expect(resolver.resolve(cFile)).toBeNull();

    // 2. Enable companion metadata, restrict regex to ^logs/
    settings.enableMetadataFiles = true;
    settings.metadataDirRegex = "^logs/";

    expect(resolver.isTargetEligible(logFile)).toBe(true);
    expect(resolver.resolve(logFile)).toEqual({
      targetFile: logFile,
      companionFile: null,
      expectedCompanionPath: "logs/2026/server.md",
      usedFallbackName: false,
    });

    // `src/engine/main.c` and `root.log` do not match `^logs/`
    expect(resolver.isTargetEligible(cFile)).toBe(false);
    expect(resolver.resolve(cFile)).toBeNull();
    expect(resolver.isTargetEligible(rootFile)).toBe(false);
    expect(resolver.resolve(rootFile)).toBeNull();

    // Direct folder regex checks with and without trailing slash
    const topLogFile = env.addFile("logs/top.log");
    expect(resolver.isTargetEligible(topLogFile)).toBe(true);
    expect(resolver.resolve(topLogFile)?.expectedCompanionPath).toBe(
      "logs/top.md"
    );
  });

  it("handles malformed metadataDirRegex safely without throwing and rejects .md or disabled extensions", () => {
    const env = createInMemoryVaultEnv();
    const logFile = env.addFile("logs/server.log");
    const mdFile = env.addFile("logs/readme.md");

    const settings: PluginSettings = {
      ...createDefaultSettings(),
      enableMetadataFiles: true,
      metadataDirRegex: "[unclosed-regex-group",
    };
    const registry = new FileTypeRegistry();
    const resolver = new LazyPairResolver(env.app, () => settings, registry);

    expect(() => resolver.matchesDirectoryRegex("logs")).not.toThrow();
    expect(resolver.matchesDirectoryRegex("logs")).toBe(false);
    expect(resolver.resolve(logFile)).toBeNull();

    // Valid regex `.*`, but `.md` files and disabled extensions are never eligible target files
    settings.metadataDirRegex = ".*";
    expect(resolver.isTargetEligible(mdFile)).toBe(false);
    expect(resolver.resolve(mdFile)).toBeNull();

    registry.updateConfig("log", { enabled: false });
    expect(resolver.isTargetEligible(logFile)).toBe(false);
    expect(resolver.resolve(logFile)).toBeNull();
  });

  it("resolves <basename>.md when linked or unoccupied and falls back to <basename>.<ext>.md on collision", () => {
    const env = createInMemoryVaultEnv();
    const settings: PluginSettings = {
      ...createDefaultSettings(),
      enableMetadataFiles: true,
      metadataDirRegex: ".*",
    };
    const resolver = new LazyPairResolver(env.app, () => settings);

    const serverLog = env.addFile("logs/server.log");
    const serverJson = env.addFile("logs/server.json");

    // Case 1: Neither `logs/server.md` nor `logs/server.log.md` exists yet
    expect(resolver.resolve(serverLog)).toEqual({
      targetFile: serverLog,
      companionFile: null,
      expectedCompanionPath: "logs/server.md",
      usedFallbackName: false,
    });

    // Case 2: `logs/server.md` exists and links to `[[server.log]]`
    const serverMd = env.addFile("logs/server.md", {
      "file-support-target": "[[server.log]]",
    });
    expect(resolver.resolve(serverLog)).toEqual({
      targetFile: serverLog,
      companionFile: serverMd,
      expectedCompanionPath: "logs/server.md",
      usedFallbackName: false,
    });

    // Sibling `logs/server.json` sees `logs/server.md` linked to `server.log` -> falls back to `logs/server.json.md`
    expect(resolver.resolve(serverJson)).toEqual({
      targetFile: serverJson,
      companionFile: null,
      expectedCompanionPath: "logs/server.json.md",
      usedFallbackName: true,
    });

    // Create `logs/server.json.md` linking to `[[server.json]]`
    const serverJsonMd = env.addFile("logs/server.json.md", {
      "file-support-target": "[[server.json]]",
    });
    expect(resolver.resolve(serverJson)).toEqual({
      targetFile: serverJson,
      companionFile: serverJsonMd,
      expectedCompanionPath: "logs/server.json.md",
      usedFallbackName: true,
    });

    // Reverse lookup for both companions
    expect(resolver.resolveTargetForCompanion(serverMd)).toBe(serverLog);
    expect(resolver.resolveTargetForCompanion(serverJsonMd)).toBe(serverJson);

    // Case 3: Standalone note `notes/report.md` (no `file-support-target`) collides with `notes/report.patch`
    const standaloneMd = env.addFile("notes/report.md", {
      title: "Standalone Report",
    });
    const reportPatch = env.addFile("notes/report.patch");

    expect(resolver.resolveTargetForCompanion(standaloneMd)).toBeNull();
    expect(resolver.resolve(reportPatch)).toEqual({
      targetFile: reportPatch,
      companionFile: null,
      expectedCompanionPath: "notes/report.patch.md",
      usedFallbackName: true,
    });
  });

  it("validates frontmatter wiki-links across formats and non-destructively merges frontmatter tags", async () => {
    const env = createInMemoryVaultEnv();
    const settings: PluginSettings = {
      ...createDefaultSettings(),
      enableMetadataFiles: true,
      metadataDirRegex: ".*",
      metadataDefaultTags: ["file-metadata", "#log-entry"],
    };
    const resolver = new LazyPairResolver(env.app, () => settings);

    const targetFile = env.addFile("logs/build.log");

    // Various wiki-link formats in frontmatter
    expect(extractWikiLinkTarget("[[build.log]]")).toBe("build.log");
    expect(extractWikiLinkTarget('"[[logs/build.log|Build Log]]"')).toBe(
      "logs/build.log"
    );
    expect(extractWikiLinkTarget("![[build.log#L5]]")).toBe("build.log");
    expect(extractWikiLinkTarget([["build.log"]])).toBe("build.log");
    expect(extractWikiLinkTarget(null)).toBeNull();
    expect(extractWikiLinkTarget("")).toBeNull();

    // Link matching checks folder locality
    expect(
      doesFrontmatterLinkMatchTarget("[[build.log]]", targetFile, "logs")
    ).toBe(true);
    expect(
      doesFrontmatterLinkMatchTarget("[[logs/build.log]]", targetFile, "logs")
    ).toBe(true);
    expect(
      doesFrontmatterLinkMatchTarget([["build.log"]], targetFile, "logs")
    ).toBe(true);
    expect(
      doesFrontmatterLinkMatchTarget("[[other/build.log]]", targetFile, "logs")
    ).toBe(false);
    expect(
      doesFrontmatterLinkMatchTarget("[[build.log]]", targetFile, "other")
    ).toBe(false);

    expect(formatTargetWikiLink(targetFile, "logs")).toBe("[[build.log]]");
    expect(formatTargetWikiLink(targetFile, "archive")).toBe(
      "[[logs/build.log]]"
    );

    // Non-destructive tag merging (deduplicates with/without `#`, preserves user tags)
    expect(
      mergeFrontmatterTags(
        ["#custom-user-tag", "file-metadata"],
        ["file-metadata", "#log-entry"]
      )
    ).toEqual(["#custom-user-tag", "file-metadata", "log-entry"]);

    expect(
      mergeFrontmatterTags("alpha, #beta", ["file-metadata", "beta"])
    ).toEqual(["alpha", "#beta", "file-metadata"]);

    // Non-destructive frontmatter mutation via processFrontMatter
    const companionMd = env.addFile("logs/build.md", {
      title: "My Build Notes",
      author: "Alice",
      tags: ["user-tag", "#file-metadata"],
    });

    await resolver.writeCompanionFrontmatter(companionMd, targetFile, {
      extractedLines: 42,
    });

    expect(env.app.fileManager.processFrontMatter).toHaveBeenCalledTimes(1);
    const updatedFm = env.frontmatters.get("logs/build.md");
    expect(updatedFm).toEqual({
      title: "My Build Notes",
      author: "Alice",
      extractedLines: 42,
      "file-support-target": "[[build.log]]",
      tags: ["user-tag", "#file-metadata", "log-entry"],
    });
  });
});

describe("MetadataCompanionMiddleware EventBus & Vault Lifecycle", () => {
  beforeEach(() => {
    Notice.clear();
  });

  it("handles metadata:resolve and metadata:open-or-create on demand, respecting default disabled state and collision fallback", async () => {
    const env = createInMemoryVaultEnv();
    const settings: PluginSettings = createDefaultSettings();
    const registry = new FileTypeRegistry();
    const bus = new EventBus();
    const resolver = new LazyPairResolver(env.app, () => settings, registry);
    const middleware = new MetadataCompanionMiddleware(env.app, resolver);
    middleware.register(bus);

    const openFileSpy = vi.fn(async () => {});
    env.app.workspace.getLeaf = vi.fn(() => ({ openFile: openFileSpy }));

    const extractSpy = vi.fn();
    bus.on("metadata:extract", extractSpy);

    const logFile = env.addFile("logs/app.log");
    const jsonFile = env.addFile("logs/app.json");

    // 1. Default disabled: metadata:open-or-create does NOT create or open a file
    const disabledOpen = await bus.emit("metadata:open-or-create", {
      app: env.app,
      targetFile: logFile,
    });
    expect(disabledOpen.companionFile).toBeNull();
    expect(env.app.vault.create).not.toHaveBeenCalled();
    expect(openFileSpy).not.toHaveBeenCalled();

    // 2. Enable companion metadata
    settings.enableMetadataFiles = true;
    await bus.emit("config:updated", { settings });

    // Create companion for `logs/app.log` -> creates `logs/app.md`
    const createdPrimary = await bus.emit("metadata:open-or-create", {
      app: env.app,
      targetFile: logFile,
      openInNewLeaf: true,
    });
    expect(createdPrimary.companionFile).toBeDefined();
    expect(createdPrimary.companionFile?.path).toBe("logs/app.md");
    expect(env.app.vault.create).toHaveBeenCalledTimes(1);
    expect(env.app.workspace.getLeaf).toHaveBeenCalledWith(true);
    expect(openFileSpy).toHaveBeenCalledWith(createdPrimary.companionFile);
    expect(extractSpy).toHaveBeenCalledTimes(1);
    expect(env.frontmatters.get("logs/app.md")).toEqual({
      "file-support-target": "[[app.log]]",
      tags: ["file-metadata"],
    });

    // Calling metadata:open-or-create a second time opens existing `logs/app.md` without calling vault.create or processFrontMatter again
    env.app.vault.create.mockClear();
    env.app.fileManager.processFrontMatter.mockClear();
    extractSpy.mockClear();
    const reopenedPrimary = await bus.emit("metadata:open-or-create", {
      app: env.app,
      targetFile: logFile,
    });
    expect(reopenedPrimary.companionFile?.path).toBe("logs/app.md");
    expect(env.app.vault.create).not.toHaveBeenCalled();
    expect(env.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    expect(extractSpy).not.toHaveBeenCalled();

    // 3. Sibling `logs/app.json` collides on `logs/app.md` -> creates `logs/app.json.md`
    const createdFallback = await bus.emit("metadata:open-or-create", {
      app: env.app,
      targetFile: jsonFile,
    });
    expect(createdFallback.companionFile?.path).toBe("logs/app.json.md");
    expect(env.frontmatters.get("logs/app.json.md")).toEqual({
      "file-support-target": "[[app.json]]",
      tags: ["file-metadata"],
    });

    // 4. If both `<basename>.md` and `<basename>.<ext>.md` are already occupied by unrelated notes,
    // refuses to overwrite user notes and displays a Notice
    env.addFile("logs/conflict.md", { title: "Unrelated 1" });
    env.addFile("logs/conflict.patch.md", { title: "Unrelated 2" });
    const conflictPatch = env.addFile("logs/conflict.patch");

    Notice.clear();
    const conflictRes = await bus.emit("metadata:open-or-create", {
      app: env.app,
      targetFile: conflictPatch,
    });
    expect(conflictRes.companionFile).toBeNull();
    expect(Notice.instances.length).toBe(1);
    expect(env.frontmatters.get("logs/conflict.patch.md")).toEqual({
      title: "Unrelated 2",
    });

    middleware.destroy();
  });

  it("synchronizes companion filename and YAML frontmatter on target rename/move even when oldPath is missing and without prior resolve()", async () => {
    const env = createInMemoryVaultEnv();
    const settings: PluginSettings = {
      ...createDefaultSettings(),
      enableMetadataFiles: true,
      metadataDirRegex: "^logs",
    };
    const registry = new FileTypeRegistry();
    const bus = new EventBus();
    const resolver = new LazyPairResolver(env.app, () => settings, registry);
    const middleware = new MetadataCompanionMiddleware(env.app, resolver);
    middleware.register(bus);

    // Scenario A: Rename `logs/app.log` -> `logs/service.log` when `resolve()` was NEVER called before
    // and `logs/app.log` is already missing from `vault.getAbstractFileByPath("logs/app.log")`
    const appLog = env.addFile("logs/app.log");
    const appMd = env.addFile("logs/app.md", {
      "file-support-target": "[[app.log]]",
      tags: ["file-metadata", "production"],
      customNote: "preserve me",
    });

    const oldPathA = env.renameTargetInVault(appLog, "logs/service.log");
    expect(env.app.vault.getAbstractFileByPath("logs/app.log")).toBeNull();

    await middleware.handleVaultRename(appLog, oldPathA);

    expect(appMd.path).toBe("logs/service.md");
    expect(env.files.get("logs/service.md")).toBe(appMd);
    expect(env.files.get("logs/app.md")).toBeUndefined();
    expect(env.frontmatters.get("logs/service.md")).toEqual({
      "file-support-target": "[[service.log]]",
      tags: ["file-metadata", "production"],
      customNote: "preserve me",
    });

    // Scenario B: Sibling collision during rename
    // `logs/config.md` is a standalone note; renaming `logs/service.log` -> `logs/config.log`
    // must rename `logs/service.md` to fallback `logs/config.log.md` without clobbering `logs/config.md`
    const standaloneConfigMd = env.addFile("logs/config.md", {
      title: "Standalone Config Doc",
    });

    const oldPathB = env.renameTargetInVault(appLog, "logs/config.log");
    await middleware.handleVaultRename(appLog, oldPathB);

    expect(appMd.path).toBe("logs/config.log.md");
    expect(env.files.get("logs/config.md")).toBe(standaloneConfigMd);
    expect(env.frontmatters.get("logs/config.md")).toEqual({
      title: "Standalone Config Doc",
    });
    expect(env.frontmatters.get("logs/config.log.md")).toEqual({
      "file-support-target": "[[config.log]]",
      tags: ["file-metadata", "production"],
      customNote: "preserve me",
    });

    // Scenario C: Renaming `logs/config.log` -> `logs/worker.log` (where `logs/worker.md` is free)
    // promotes fallback `logs/config.log.md` back to clean primary `logs/worker.md`
    const oldPathC = env.renameTargetInVault(appLog, "logs/worker.log");
    await middleware.handleVaultRename(appLog, oldPathC);

    expect(appMd.path).toBe("logs/worker.md");
    expect(env.frontmatters.get("logs/worker.md")?.["file-support-target"]).toBe(
      "[[worker.log]]"
    );

    // Scenario D: Works even if Obsidian's link updater already updated `file-support-target`
    // to the new target filename before `vault.on("rename")` reached our listener
    env.frontmatters.set("logs/worker.md", {
      ...env.frontmatters.get("logs/worker.md")!,
      "file-support-target": "[[ logs/archive/daemon.log ]]",
    });
    const oldPathD = env.renameTargetInVault(
      appLog,
      "logs/archive/daemon.log"
    );
    await middleware.handleVaultRename(appLog, oldPathD);

    expect(appMd.path).toBe("logs/archive/daemon.md");
    expect(
      env.frontmatters.get("logs/archive/daemon.md")?.["file-support-target"]
    ).toBe("[[daemon.log]]");

    // Scenario E: Moving target file out of matching `^logs` directory into `src/daemon.log`
    // keeps companion note in `logs/archive/daemon.md` and updates its link to full vault path
    const oldPathE = env.renameTargetInVault(appLog, "src/daemon.log");
    await middleware.handleVaultRename(appLog, oldPathE);

    expect(appMd.path).toBe("logs/archive/daemon.md");
    expect(
      env.frontmatters.get("logs/archive/daemon.md")?.["file-support-target"]
    ).toBe("[[src/daemon.log]]");

    // Scenario F: Sibling files `logs/sib.json` (owning `logs/sib.md`) and `logs/sib.log` (owning `logs/sib.log.md`):
    // renaming `logs/sib.log` -> `logs/renamed-sib.log` must leave `logs/sib.md` untouched and rename `logs/sib.log.md` -> `logs/renamed-sib.md`
    const sibJson = env.addFile("logs/sib.json");
    const sibMd = env.addFile("logs/sib.md", {
      "file-support-target": "[[sib.json]]",
    });
    const sibLog = env.addFile("logs/sib.log");
    const sibLogMd = env.addFile("logs/sib.log.md", {
      "file-support-target": "[[sib.log]]",
    });

    const oldPathF = env.renameTargetInVault(sibLog, "logs/renamed-sib.log");
    await middleware.handleVaultRename(sibLog, oldPathF);

    expect(sibMd.path).toBe("logs/sib.md");
    expect(env.frontmatters.get("logs/sib.md")?.["file-support-target"]).toBe(
      "[[sib.json]]"
    );
    expect(sibLogMd.path).toBe("logs/renamed-sib.md");
    expect(
      env.frontmatters.get("logs/renamed-sib.md")?.["file-support-target"]
    ).toBe("[[renamed-sib.log]]");
    expect(resolver.resolve(sibJson)?.companionFile).toBe(sibMd);
    expect(resolver.resolve(sibLog)?.companionFile).toBe(sibLogMd);

    middleware.destroy();
  });

  it("handles Vault delete events non-destructively and integrates with SupportedFileView header action", async () => {
    const env = createInMemoryVaultEnv();
    const plugin = new FileSupportPlugin(env.app, createMockManifest());
    await plugin.onload();

    plugin.settings.enableMetadataFiles = true;
    await plugin.saveSettings();

    const openFileSpy = vi.fn(async () => {});
    env.app.workspace.getLeaf = vi.fn(() => ({ openFile: openFileSpy }));

    const logFile = env.addFile("logs/access.log", undefined, "GET /index 200");

    // Open `logs/access.log` in SupportedFileView and click the metadata header button
    const leaf = createMockLeaf();
    const view = new SupportedFileView(leaf, plugin);
    view.onload();
    await view.onLoadFile(logFile);

    await view.openCompanionMetadata();

    const companion = env.files.get("logs/access.md");
    expect(companion).toBeDefined();
    expect(openFileSpy).toHaveBeenCalledWith(companion);
    expect(env.frontmatters.get("logs/access.md")).toEqual({
      "file-support-target": "[[access.log]]",
      tags: ["file-metadata"],
    });

    // Deleting target file `logs/access.log` does NOT delete `logs/access.md`
    env.removeFile("logs/access.log");
    env.app.vault.trigger("delete", logFile);
    expect(env.files.get("logs/access.md")).toBe(companion);

    // Re-add target file, then delete companion `logs/access.md` -> resolve() returns companionFile: null
    const restoredLog = env.addFile("logs/access.log");
    expect(plugin.pairResolver.resolve(restoredLog)?.companionFile).toBe(
      companion
    );

    env.removeFile("logs/access.md");
    env.app.vault.trigger("delete", companion);
    expect(plugin.pairResolver.resolve(restoredLog)?.companionFile).toBeNull();

    view.onunload();
    await plugin.onunload();
    expect(env.app.vault.listenerCount("rename")).toBe(0);
    expect(env.app.vault.listenerCount("delete")).toBe(0);
    expect(env.app.metadataCache.listenerCount("changed")).toBe(0);
    expect(env.app.metadataCache.listenerCount("deleted")).toBe(0);
  });

  it("does not rewrite YAML frontmatter or re-add user-removed default tags on reopen or target rename", async () => {
    const env = createInMemoryVaultEnv();
    const settings: PluginSettings = {
      ...createDefaultSettings(),
      enableMetadataFiles: true,
      metadataDirRegex: ".*",
      metadataDefaultTags: ["file-metadata", "default-tag"],
    };
    const registry = new FileTypeRegistry();
    const bus = new EventBus();
    const resolver = new LazyPairResolver(env.app, () => settings, registry);
    const middleware = new MetadataCompanionMiddleware(env.app, resolver);
    middleware.register(bus);

    const logFile = env.addFile("logs/app.log");

    // 1. Initial creation writes default tags
    const created = await bus.emit("metadata:open-or-create", {
      app: env.app,
      targetFile: logFile,
    });
    expect(created.companionFile?.path).toBe("logs/app.md");
    expect(env.frontmatters.get("logs/app.md")).toEqual({
      "file-support-target": "[[app.log]]",
      tags: ["file-metadata", "default-tag"],
    });

    // 2. User edits companion note frontmatter: removes default tags and uses singular `tag:` key
    env.frontmatters.set("logs/app.md", {
      "file-support-target": "[[app.log]]",
      tag: "user-curated-only",
      notes: "keep intact",
    });
    env.app.fileManager.processFrontMatter.mockClear();
    env.app.vault.create.mockClear();

    // 3. Reopening the companion note must NOT call processFrontMatter or re-add removed default tags
    const reopened = await bus.emit("metadata:open-or-create", {
      app: env.app,
      targetFile: logFile,
    });
    expect(reopened.companionFile?.path).toBe("logs/app.md");
    expect(env.app.vault.create).not.toHaveBeenCalled();
    expect(env.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    expect(env.frontmatters.get("logs/app.md")).toEqual({
      "file-support-target": "[[app.log]]",
      tag: "user-curated-only",
      notes: "keep intact",
    });

    // 4. Renaming target file updates `file-support-target` without re-adding removed default tags or mutating `tag:`
    const oldPath = env.renameTargetInVault(logFile, "logs/renamed-app.log");
    await middleware.handleVaultRename(logFile, oldPath);

    expect(env.frontmatters.get("logs/renamed-app.md")).toEqual({
      "file-support-target": "[[renamed-app.log]]",
      tag: "user-curated-only",
      notes: "keep intact",
    });

    middleware.destroy();
  });

  it("serializes concurrent metadata:open-or-create calls so vault.create runs once and callers receive the same TFile", async () => {
    const env = createInMemoryVaultEnv();
    const settings: PluginSettings = {
      ...createDefaultSettings(),
      enableMetadataFiles: true,
      metadataDirRegex: ".*",
    };
    const registry = new FileTypeRegistry();
    const bus = new EventBus();
    const resolver = new LazyPairResolver(env.app, () => settings, registry);
    const middleware = new MetadataCompanionMiddleware(env.app, resolver);
    middleware.register(bus);

    // Add async delay to vault.create so concurrent callers overlap while creation is still pending
    const baseCreate = env.app.vault.create;
    env.app.vault.create = vi.fn(async (path: string, data: string) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      if (env.files.has(normalizePath(path))) {
        throw new Error(`File already exists: ${path}`);
      }
      return baseCreate(path, data);
    });

    const logFile = env.addFile("logs/concurrent.log");

    // 1. Two concurrent open-or-create emissions for the SAME target file
    const [res1, res2] = await Promise.all([
      bus.emit("metadata:open-or-create", {
        app: env.app,
        targetFile: logFile,
      }),
      bus.emit("metadata:open-or-create", {
        app: env.app,
        targetFile: logFile,
      }),
    ]);

    expect(env.app.vault.create).toHaveBeenCalledTimes(1);
    expect(env.app.fileManager.processFrontMatter).toHaveBeenCalledTimes(1);
    expect(res1.companionFile).not.toBeNull();
    expect(res1.companionFile).toBe(res2.companionFile);
    expect(res1.companionFile?.path).toBe("logs/concurrent.md");

    // 2. Concurrent open-or-create emissions for two SIBLING files sharing the same basename
    env.app.vault.create.mockClear();
    const sibLog = env.addFile("logs/shared.log");
    const sibJson = env.addFile("logs/shared.json");

    const [sibRes1, sibRes2] = await Promise.all([
      bus.emit("metadata:open-or-create", {
        app: env.app,
        targetFile: sibLog,
      }),
      bus.emit("metadata:open-or-create", {
        app: env.app,
        targetFile: sibJson,
      }),
    ]);

    expect(env.app.vault.create).toHaveBeenCalledTimes(2);
    expect(sibRes1.companionFile?.path).toBe("logs/shared.md");
    expect(sibRes2.companionFile?.path).toBe("logs/shared.json.md");

    middleware.destroy();
  });

  it("catches processFrontMatter and vault errors during open-or-create and rename without unhandled rejections", async () => {
    const env = createInMemoryVaultEnv();
    const settings: PluginSettings = {
      ...createDefaultSettings(),
      enableMetadataFiles: true,
      metadataDirRegex: ".*",
    };
    const registry = new FileTypeRegistry();
    const bus = new EventBus();
    const resolver = new LazyPairResolver(env.app, () => settings, registry);
    const middleware = new MetadataCompanionMiddleware(env.app, resolver);
    middleware.register(bus);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logFile = env.addFile("logs/broken.log");

    // 1. processFrontMatter throws malformed YAML error during metadata:open-or-create
    env.app.fileManager.processFrontMatter = vi.fn(async () => {
      throw new Error("YAMLParseError: unexpected token in frontmatter");
    });

    Notice.clear();
    const failedOpen = await bus.emit("metadata:open-or-create", {
      app: env.app,
      targetFile: logFile,
    });
    expect(failedOpen.companionFile).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    expect(Notice.instances.length).toBeGreaterThanOrEqual(1);
    expect(Notice.instances[0].message).toContain("YAMLParseError");

    // 2. processFrontMatter throws malformed YAML error during vault rename
    const renameTarget = env.addFile("logs/service.log");
    env.addFile("logs/service.md", {
      "file-support-target": "[[service.log]]",
    });

    Notice.clear();
    warnSpy.mockClear();
    const oldPath = env.renameTargetInVault(
      renameTarget,
      "logs/service-renamed.log"
    );

    await expect(
      middleware.handleVaultRename(renameTarget, oldPath)
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    expect(Notice.instances.length).toBeGreaterThanOrEqual(1);
    expect(Notice.instances[0].message).toContain("YAMLParseError");

    warnSpy.mockRestore();
    middleware.destroy();
  });

  it("prefers freshly written pending frontmatter over stale non-null metadataCache across consecutive renames until metadataCache emits changed", async () => {
    const env = createInMemoryVaultEnv();
    const settings: PluginSettings = {
      ...createDefaultSettings(),
      enableMetadataFiles: true,
      metadataDirRegex: ".*",
    };
    const registry = new FileTypeRegistry();
    const bus = new EventBus();
    const resolver = new LazyPairResolver(env.app, () => settings, registry);
    const middleware = new MetadataCompanionMiddleware(env.app, resolver);
    middleware.register(bus);

    // Simulate Obsidian's asynchronous metadataCache:
    // `cachedFrontmatters` holds the stale cache returned by `getFileCache`, while `env.frontmatters`
    // holds the actual disk frontmatter written by `processFrontMatter`.
    const cachedFrontmatters = new Map<string, Record<string, any>>();
    const logFile = env.addFile("logs/app.log");
    const companionMd = env.addFile("logs/app.md", {
      "file-support-target": "[[app.log]]",
      tags: ["file-metadata"],
    });
    cachedFrontmatters.set("logs/app.md", {
      "file-support-target": "[[app.log]]",
      tags: ["file-metadata"],
    });

    env.app.metadataCache.getFileCache = vi.fn((file: TFile) => {
      if (!file) return null;
      const norm = normalizePath(file.path);
      const cached = cachedFrontmatters.get(norm);
      if (cached) {
        return { frontmatter: { ...cached } };
      }
      // Even after rename, simulate stale non-null cache still returning the old `[[app.log]]` frontmatter!
      return {
        frontmatter: {
          "file-support-target": "[[app.log]]",
          tags: ["file-metadata"],
        },
      };
    });

    // Rename 1: `logs/app.log` -> `logs/step1.log`
    const oldPath1 = env.renameTargetInVault(logFile, "logs/step1.log");
    await middleware.handleVaultRename(logFile, oldPath1);

    expect(companionMd.path).toBe("logs/step1.md");
    // Even though getFileCache(companionMd) still returns stale `[[app.log]]`,
    // resolver.getFrontmatter returns the pending `[[step1.log]]`
    expect(
      env.app.metadataCache.getFileCache(companionMd).frontmatter[
        "file-support-target"
      ]
    ).toBe("[[app.log]]");
    expect(resolver.getFrontmatter(companionMd)?.["file-support-target"]).toBe(
      "[[step1.log]]"
    );

    // Rename 2 immediately (before metadataCache has re-indexed Rename 1): `logs/step1.log` -> `logs/step2.log`
    const oldPath2 = env.renameTargetInVault(logFile, "logs/step2.log");
    await middleware.handleVaultRename(logFile, oldPath2);

    expect(companionMd.path).toBe("logs/step2.md");
    expect(resolver.getFrontmatter(companionMd)?.["file-support-target"]).toBe(
      "[[step2.log]]"
    );
    expect(resolver.resolve(logFile)?.companionFile).toBe(companionMd);

    // Now simulate Obsidian's metadata indexer catching up and emitting `metadataCache.on("changed")`
    cachedFrontmatters.set("logs/step2.md", {
      "file-support-target": "[[step2.log]]",
      tags: ["file-metadata"],
      indexedByObsidian: true,
    });
    env.app.metadataCache.trigger("changed", companionMd);

    // Pending state is invalidated on "changed", so resolver now reads the newly indexed cache entry
    expect(resolver.getFrontmatter(companionMd)).toEqual({
      "file-support-target": "[[step2.log]]",
      tags: ["file-metadata"],
      indexedByObsidian: true,
    });

    middleware.destroy();
  });
});
