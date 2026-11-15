import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Menu,
  Notice,
  TFile,
  TFolder,
  createMockApp,
  createMockLeaf,
  createMockManifest,
  createMockTFile,
  normalizePath,
} from "./__mocks__/obsidian";
import FileSupportPlugin from "../src/main";
import { splitFilePath } from "../src/metadata/LazyPairResolver";
import { COMPANION_CONTEXT_MENU_TITLE } from "../src/middlewares/FileTreeMiddleware";
import { SupportedFileView } from "../src/views/SupportedFileView";

interface TestVaultAndDomEnv {
  app: any;
  files: Map<string, TFile>;
  contents: Map<string, string>;
  frontmatters: Map<string, Record<string, any>>;
  navContainer: HTMLElement;
  addFile: (
    path: string,
    frontmatter?: Record<string, any>,
    content?: string
  ) => TFile;
  removeFile: (path: string) => TFile | undefined;
  addTreeFileItem: (
    parentEl: HTMLElement,
    filePath: string,
    opts?: { nativeBadge?: string; displayText?: string }
  ) => {
    navFileEl: HTMLElement;
    titleEl: HTMLElement;
    contentEl: HTMLElement;
  };
  addTreeFolderItem: (
    parentEl: HTMLElement,
    folderPath: string
  ) => {
    navFolderEl: HTMLElement;
    folderTitleEl: HTMLElement;
    childrenEl: HTMLElement;
  };
  getTreeFileItem: (filePath: string) => {
    navFileEl: HTMLElement | null;
    titleEl: HTMLElement | null;
  };
}

function createTestVaultAndDomEnv(): TestVaultAndDomEnv {
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
    app.vault.trigger("create", file);
    return file;
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
    }
  );

  // Build realistic Obsidian File Explorer DOM container attached to document.body
  const navContainer = document.createElement("div");
  navContainer.className = "nav-files-container node-insert-event";
  document.body.appendChild(navContainer);

  app.workspace.getLeavesOfType = vi.fn((type: string) => {
    if (type === "file-explorer") {
      return [{ view: { containerEl: navContainer } }];
    }
    return [];
  });

  const addTreeFolderItem = (parentEl: HTMLElement, folderPath: string) => {
    const navFolderEl = document.createElement("div");
    navFolderEl.className = "tree-item nav-folder";

    const folderTitleEl = document.createElement("div");
    folderTitleEl.className =
      "tree-item-self is-clickable mod-collapsible nav-folder-title";
    folderTitleEl.setAttribute("data-path", folderPath);

    const folderContentEl = document.createElement("div");
    folderContentEl.className = "tree-item-inner nav-folder-title-content";
    folderContentEl.textContent = folderPath.split("/").pop() ?? folderPath;
    folderTitleEl.appendChild(folderContentEl);

    const childrenEl = document.createElement("div");
    childrenEl.className = "tree-item-children nav-folder-children";

    navFolderEl.appendChild(folderTitleEl);
    navFolderEl.appendChild(childrenEl);
    parentEl.appendChild(navFolderEl);

    return { navFolderEl, folderTitleEl, childrenEl };
  };

  const addTreeFileItem = (
    parentEl: HTMLElement,
    filePath: string,
    opts?: { nativeBadge?: string; displayText?: string }
  ) => {
    const parts = splitFilePath(filePath);
    const navFileEl = document.createElement("div");
    navFileEl.className = "tree-item nav-file";

    const titleEl = document.createElement("div");
    titleEl.className = "tree-item-self is-clickable nav-file-title";
    titleEl.setAttribute("data-path", parts.path);

    const contentEl = document.createElement("div");
    contentEl.className = "tree-item-inner nav-file-title-content";
    contentEl.textContent =
      opts?.displayText ??
      (parts.extension === "md" ? parts.basename : parts.name);
    titleEl.appendChild(contentEl);

    if (opts?.nativeBadge) {
      const nativeTag = document.createElement("div");
      nativeTag.className = "nav-file-tag";
      nativeTag.textContent = opts.nativeBadge;
      titleEl.appendChild(nativeTag);
    }

    navFileEl.appendChild(titleEl);
    parentEl.appendChild(navFileEl);

    return { navFileEl, titleEl, contentEl };
  };

  const getTreeFileItem = (filePath: string) => {
    const norm = normalizePath(filePath);
    const titleEl = navContainer.querySelector(
      `.nav-file-title[data-path="${norm}"]`
    ) as HTMLElement | null;
    const navFileEl =
      (titleEl?.closest(".nav-file") as HTMLElement | null) ?? null;
    return { navFileEl, titleEl };
  };

  return {
    app,
    files,
    contents,
    frontmatters,
    navContainer,
    addFile,
    removeFile,
    addTreeFileItem,
    addTreeFolderItem,
    getTreeFileItem,
  };
}

describe("FileTreeMiddleware, File Explorer Badges, Companion Hiding/Underlining, and UX Triggers", () => {
  beforeEach(() => {
    Notice.clear();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("injects .nav-file-tag badges for supported extensions, skips native Obsidian badges idempotently, and updates live on config:updated", async () => {
    const env = createTestVaultAndDomEnv();
    env.addFile("logs/server.log");
    env.addFile("patches/fix.patch");
    env.addFile("src/main.c");
    env.addFile("config/settings.json");
    env.addFile("notes/daily.md");
    env.addFile("assets/manual.pdf");

    const logsFolder = env.addTreeFolderItem(env.navContainer, "logs");
    const logItem = env.addTreeFileItem(
      logsFolder.childrenEl,
      "logs/server.log"
    );
    const patchItem = env.addTreeFileItem(
      env.navContainer,
      "patches/fix.patch"
    );
    const cItem = env.addTreeFileItem(env.navContainer, "src/main.c");
    // Simulate Obsidian having already rendered a native `.nav-file-tag` on settings.json
    const jsonItem = env.addTreeFileItem(
      env.navContainer,
      "config/settings.json",
      { nativeBadge: "JSON" }
    );
    const mdItem = env.addTreeFileItem(env.navContainer, "notes/daily.md");
    const pdfItem = env.addTreeFileItem(env.navContainer, "assets/manual.pdf", {
      nativeBadge: "PDF",
    });

    const plugin = new FileSupportPlugin(env.app, createMockManifest());
    await plugin.onload();

    // 1. Supported files without native badges receive `.nav-file-tag.file-support-badge`
    const logBadges = logItem.titleEl.querySelectorAll(".nav-file-tag");
    expect(logBadges.length).toBe(1);
    expect(logBadges[0].classList.contains("file-support-badge")).toBe(true);
    expect(logBadges[0].textContent).toBe("LOG");

    const patchBadges = patchItem.titleEl.querySelectorAll(".nav-file-tag");
    expect(patchBadges.length).toBe(1);
    expect(patchBadges[0].textContent).toBe("PATCH");

    const cBadges = cItem.titleEl.querySelectorAll(".nav-file-tag");
    expect(cBadges.length).toBe(1);
    expect(cBadges[0].textContent).toBe("C");

    // 2. Native badge detection: settings.json already had a native `.nav-file-tag` -> not duplicated!
    const jsonBadges = jsonItem.titleEl.querySelectorAll(".nav-file-tag");
    expect(jsonBadges.length).toBe(1);
    expect(jsonBadges[0].classList.contains("file-support-badge")).toBe(false);
    expect(jsonBadges[0].textContent).toBe("JSON");

    // 3. Markdown notes have no badge; native PDF badge is untouched
    expect(mdItem.titleEl.querySelectorAll(".nav-file-tag").length).toBe(0);
    expect(pdfItem.titleEl.querySelectorAll(".nav-file-tag").length).toBe(1);
    expect(
      pdfItem.titleEl
        .querySelector(".nav-file-tag")
        ?.classList.contains("file-support-badge")
    ).toBe(false);

    // 4. Re-emitting tree:decorate is strictly idempotent (same badge element reference, no duplicates)
    const firstLogBadgeEl = logBadges[0];
    await plugin.eventBus.emit("tree:decorate", {
      app: env.app,
      containerEl: env.navContainer,
    });
    const logBadgesAfter = logItem.titleEl.querySelectorAll(".nav-file-tag");
    expect(logBadgesAfter.length).toBe(1);
    expect(logBadgesAfter[0]).toBe(firstLogBadgeEl);

    // 5. Updating badgeLabel in settings updates the badge text in place
    await plugin.updateFileTypeConfig("log", { badgeLabel: "SYSLOG" });
    expect(logItem.titleEl.querySelector(".nav-file-tag")?.textContent).toBe(
      "SYSLOG"
    );
    expect(logItem.titleEl.querySelectorAll(".nav-file-tag").length).toBe(1);

    // 6. Disabling .log in settings removes the plugin badge while leaving native badges untouched
    await plugin.updateFileTypeConfig("log", { enabled: false });
    expect(logItem.titleEl.querySelectorAll(".nav-file-tag").length).toBe(0);
    expect(jsonItem.titleEl.querySelectorAll(".nav-file-tag").length).toBe(1);
    expect(pdfItem.titleEl.querySelectorAll(".nav-file-tag").length).toBe(1);

    await plugin.onunload();
  });

  it("decorates archive files (tar, tgz, gz, tbz2, tbz, bz2, txz, xz, tzst, zst) in file tree", async () => {
    const env = createTestVaultAndDomEnv();

    const tarFile = env.addFile("archives/archive.tar");
    const tgzFile = env.addFile("archives/bundle.tgz");
    const tarGzFile = env.addFile("archives/data.tar.gz");
    const tbz2File = env.addFile("archives/backup.tbz2");
    const tbzFile = env.addFile("archives/backup.tbz");
    const tarBz2File = env.addFile("archives/backup.tar.bz2");
    const txzFile = env.addFile("archives/dist.txz");
    const tarXzFile = env.addFile("archives/dist.tar.xz");
    const tzstFile = env.addFile("archives/pack.tzst");
    const tarZstFile = env.addFile("archives/pack.tar.zst");

    const folder = env.addTreeFolderItem(env.navContainer, "archives");
    const tarItem = env.addTreeFileItem(folder.childrenEl, "archives/archive.tar");
    const tgzItem = env.addTreeFileItem(folder.childrenEl, "archives/bundle.tgz");
    const tarGzItem = env.addTreeFileItem(folder.childrenEl, "archives/data.tar.gz");
    const tbz2Item = env.addTreeFileItem(folder.childrenEl, "archives/backup.tbz2");
    const tbzItem = env.addTreeFileItem(folder.childrenEl, "archives/backup.tbz");
    const tarBz2Item = env.addTreeFileItem(folder.childrenEl, "archives/backup.tar.bz2");
    const txzItem = env.addTreeFileItem(folder.childrenEl, "archives/dist.txz");
    const tarXzItem = env.addTreeFileItem(folder.childrenEl, "archives/dist.tar.xz");
    const tzstItem = env.addTreeFileItem(folder.childrenEl, "archives/pack.tzst");
    const tarZstItem = env.addTreeFileItem(folder.childrenEl, "archives/pack.tar.zst");

    const plugin = new FileSupportPlugin(env.app, createMockManifest());
    await plugin.onload();

    expect(tarItem.titleEl.querySelector(".nav-file-tag")?.textContent).toBe("TAR");
    expect(tgzItem.titleEl.querySelector(".nav-file-tag")?.textContent).toBe("TGZ");
    expect(tarGzItem.titleEl.querySelector(".nav-file-tag")?.textContent).toBe("TGZ");
    expect(tbz2Item.titleEl.querySelector(".nav-file-tag")?.textContent).toBe("TBZ2");
    expect(tbzItem.titleEl.querySelector(".nav-file-tag")?.textContent).toBe("TBZ2");
    expect(tarBz2Item.titleEl.querySelector(".nav-file-tag")?.textContent).toBe("TBZ2");
    expect(txzItem.titleEl.querySelector(".nav-file-tag")?.textContent).toBe("TXZ");
    expect(tarXzItem.titleEl.querySelector(".nav-file-tag")?.textContent).toBe("TXZ");
    expect(tzstItem.titleEl.querySelector(".nav-file-tag")?.textContent).toBe("TZST");
    expect(tarZstItem.titleEl.querySelector(".nav-file-tag")?.textContent).toBe("TZST");

    await plugin.onunload();
  });

  it("hides only verified paired companion .md notes and underlines their target files, respecting enableMetadataFiles and metadataDirRegex", async () => {
    const env = createTestVaultAndDomEnv();

    // Target files and companion notes in `logs/` (will match `^logs`)
    const serverLog = env.addFile("logs/server.log");
    const serverMd = env.addFile("logs/server.md", {
      "file-support-target": "[[server.log]]",
    });
    const serverJson = env.addFile("logs/server.json");
    const serverJsonMd = env.addFile("logs/server.json.md", {
      "file-support-target": "[[server.json]]",
    });
    const unpairedLog = env.addFile("logs/unpaired.log");

    // Unverified / standalone `.md` notes in `logs/` that MUST NOT be hidden:
    // 1) Standalone regular note without `file-support-target`
    env.addFile("logs/readme.md", { title: "Standalone Readme" });
    // 2) Orphan note whose `file-support-target` points to a non-existent file
    env.addFile("logs/orphan.md", {
      "file-support-target": "[[deleted-file.log]]",
    });
    // 3) Note whose `file-support-target` points to a different file that doesn't pair with it
    env.addFile("logs/spoofed.md", {
      "file-support-target": "[[server.log]]",
    });

    // Files outside matching directory (`src/`)
    env.addFile("src/engine.c");
    env.addFile("src/engine.md", {
      "file-support-target": "[[engine.c]]",
    });

    const logsFolder = env.addTreeFolderItem(env.navContainer, "logs");
    const serverLogDom = env.addTreeFileItem(
      logsFolder.childrenEl,
      "logs/server.log"
    );
    const serverMdDom = env.addTreeFileItem(
      logsFolder.childrenEl,
      "logs/server.md"
    );
    const serverJsonDom = env.addTreeFileItem(
      logsFolder.childrenEl,
      "logs/server.json"
    );
    const serverJsonMdDom = env.addTreeFileItem(
      logsFolder.childrenEl,
      "logs/server.json.md"
    );
    const unpairedLogDom = env.addTreeFileItem(
      logsFolder.childrenEl,
      "logs/unpaired.log"
    );
    const readmeMdDom = env.addTreeFileItem(
      logsFolder.childrenEl,
      "logs/readme.md"
    );
    const orphanMdDom = env.addTreeFileItem(
      logsFolder.childrenEl,
      "logs/orphan.md"
    );
    const spoofedMdDom = env.addTreeFileItem(
      logsFolder.childrenEl,
      "logs/spoofed.md"
    );

    const srcFolder = env.addTreeFolderItem(env.navContainer, "src");
    const engineCDom = env.addTreeFileItem(
      srcFolder.childrenEl,
      "src/engine.c"
    );
    const engineMdDom = env.addTreeFileItem(
      srcFolder.childrenEl,
      "src/engine.md"
    );

    const plugin = new FileSupportPlugin(env.app, createMockManifest());
    await plugin.onload();

    // 1. Default: enableMetadataFiles is false -> NO files are hidden or underlined
    expect(plugin.settings.enableMetadataFiles).toBe(false);
    expect(serverMdDom.navFileEl.classList.contains("is-companion-hidden")).toBe(
      false
    );
    expect(
      serverLogDom.titleEl.classList.contains("has-companion-metadata")
    ).toBe(false);

    // 2. Enable companion metadata scoped to `^logs`
    plugin.settings.enableMetadataFiles = true;
    plugin.settings.metadataDirRegex = "^logs";
    await plugin.saveSettings();

    // Verified primary pair (`logs/server.log` <-> `logs/server.md`)
    expect(
      serverLogDom.titleEl.classList.contains("has-companion-metadata")
    ).toBe(true);
    expect(serverLogDom.titleEl.getAttribute("data-companion-path")).toBe(
      serverMd.path
    );
    expect(serverLogDom.titleEl.getAttribute("data-companion-tooltip")).toContain(
      "server.md"
    );
    expect(serverMdDom.navFileEl.classList.contains("is-companion-hidden")).toBe(
      true
    );
    expect(serverMdDom.titleEl.classList.contains("is-companion-hidden")).toBe(
      true
    );
    expect(serverMdDom.titleEl.getAttribute("data-companion-for")).toBe(
      serverLog.path
    );

    // Verified collision-fallback pair (`logs/server.json` <-> `logs/server.json.md`)
    expect(
      serverJsonDom.titleEl.classList.contains("has-companion-metadata")
    ).toBe(true);
    expect(serverJsonDom.titleEl.getAttribute("data-companion-path")).toBe(
      serverJsonMd.path
    );
    expect(
      serverJsonMdDom.navFileEl.classList.contains("is-companion-hidden")
    ).toBe(true);

    // Unpaired target file (`logs/unpaired.log`) is NOT underlined
    expect(
      unpairedLogDom.titleEl.classList.contains("has-companion-metadata")
    ).toBe(false);

    // Unverified `.md` notes in `logs/` are NEVER hidden
    expect(readmeMdDom.navFileEl.classList.contains("is-companion-hidden")).toBe(
      false
    );
    expect(orphanMdDom.navFileEl.classList.contains("is-companion-hidden")).toBe(
      false
    );
    expect(
      spoofedMdDom.navFileEl.classList.contains("is-companion-hidden")
    ).toBe(false);

    // Files in `src/` (outside `^logs` regex) are NOT hidden or underlined, but `src/engine.c` still has its `C` badge
    expect(
      engineCDom.titleEl.classList.contains("has-companion-metadata")
    ).toBe(false);
    expect(engineMdDom.navFileEl.classList.contains("is-companion-hidden")).toBe(
      false
    );
    expect(engineCDom.titleEl.querySelector(".nav-file-tag")?.textContent).toBe(
      "C"
    );

    // 3. Deleting `logs/server.md` from vault removes the underline from `logs/server.log`
    env.removeFile("logs/server.md");
    env.app.vault.trigger("delete", serverMd);
    await Promise.resolve();
    expect(
      serverLogDom.titleEl.classList.contains("has-companion-metadata")
    ).toBe(false);

    // 4. Disabling companion metadata in settings clears all companion classes
    plugin.settings.enableMetadataFiles = false;
    await plugin.saveSettings();
    expect(
      serverJsonDom.titleEl.classList.contains("has-companion-metadata")
    ).toBe(false);
    expect(
      serverJsonMdDom.navFileEl.classList.contains("is-companion-hidden")
    ).toBe(false);

    await plugin.onunload();
  });

  it("observes .nav-files-container mutations without self-trigger infinite loops and safely ignores detached nodes", async () => {
    const env = createTestVaultAndDomEnv();
    env.addFile("logs/initial.log");
    env.addFile("logs/expanded.patch");
    env.addFile("logs/expanded.md", {
      "file-support-target": "[[expanded.patch]]",
    });

    const logsFolder = env.addTreeFolderItem(env.navContainer, "logs");
    env.addTreeFileItem(logsFolder.childrenEl, "logs/initial.log");

    const plugin = new FileSupportPlugin(env.app, createMockManifest());
    plugin.settings.enableMetadataFiles = true;
    await plugin.onload();
    plugin.settings.enableMetadataFiles = true;
    await plugin.saveSettings();

    const treeDecorateSpy = vi.fn();
    plugin.eventBus.on("tree:decorate", treeDecorateSpy);
    const countAfterSetup =
      plugin.fileTreeMiddleware.getDecorationPassCount();

    // 1. Wait across microtasks & macrotasks: observer must NOT self-retrigger from its own DOM writes
    await new Promise((r) => setTimeout(r, 25));
    expect(treeDecorateSpy).not.toHaveBeenCalled();
    expect(plugin.fileTreeMiddleware.getDecorationPassCount()).toBe(
      countAfterSetup
    );

    // 2. Simulate expanding a folder in File Explorer by inserting new `.nav-file` elements into `logsFolder.childrenEl`
    const expandedPatchDom = env.addTreeFileItem(
      logsFolder.childrenEl,
      "logs/expanded.patch"
    );
    const expandedMdDom = env.addTreeFileItem(
      logsFolder.childrenEl,
      "logs/expanded.md"
    );

    // Allow MutationObserver microtask to fire and settle
    await new Promise((r) => setTimeout(r, 25));

    // Exactly 1 decoration pass occurred for the folder expansion, with 0 self-trigger loops afterward
    expect(treeDecorateSpy).toHaveBeenCalledTimes(1);
    expect(plugin.fileTreeMiddleware.getDecorationPassCount()).toBe(
      countAfterSetup + 1
    );
    expect(
      expandedPatchDom.titleEl.querySelector(".nav-file-tag")?.textContent
    ).toBe("PATCH");
    expect(
      expandedPatchDom.titleEl.classList.contains("has-companion-metadata")
    ).toBe(true);
    expect(
      expandedMdDom.navFileEl.classList.contains("is-companion-hidden")
    ).toBe(true);

    // 3. Transient node added and immediately detached in the same synchronous turn is ignored
    treeDecorateSpy.mockClear();
    const passBeforeTransient =
      plugin.fileTreeMiddleware.getDecorationPassCount();

    const transientEl = document.createElement("div");
    transientEl.className = "tree-item nav-file";
    const transientTitle = document.createElement("div");
    transientTitle.className = "nav-file-title";
    transientTitle.setAttribute("data-path", "logs/transient.log");
    transientEl.appendChild(transientTitle);

    // Append and immediately remove from an unattached subtree or before observer runs
    const detachedWrapper = document.createElement("div");
    logsFolder.childrenEl.appendChild(detachedWrapper);
    detachedWrapper.appendChild(transientEl);
    logsFolder.childrenEl.removeChild(detachedWrapper);

    await new Promise((r) => setTimeout(r, 25));
    expect(treeDecorateSpy).not.toHaveBeenCalled();
    expect(plugin.fileTreeMiddleware.getDecorationPassCount()).toBe(
      passBeforeTransient
    );

    // 4. Detaching the entire `.nav-files-container` from document disconnects the observer cleanly
    env.navContainer.remove();
    env.addTreeFileItem(logsFolder.childrenEl, "logs/after-detach.log");
    await new Promise((r) => setTimeout(r, 25));
    expect(treeDecorateSpy).not.toHaveBeenCalled();

    await plugin.onunload();
  });

  it("routes normal click to open target file and capture-phase Alt+Click / Ctrl+Shift+Click to metadata:open-or-create", async () => {
    const env = createTestVaultAndDomEnv();
    const logFile = env.addFile("logs/server.log");
    const cFile = env.addFile("src/main.c");

    const logsFolder = env.addTreeFolderItem(env.navContainer, "logs");
    const logDom = env.addTreeFileItem(
      logsFolder.childrenEl,
      "logs/server.log"
    );
    const srcFolder = env.addTreeFolderItem(env.navContainer, "src");
    const cDom = env.addTreeFileItem(srcFolder.childrenEl, "src/main.c");

    const plugin = new FileSupportPlugin(env.app, createMockManifest());
    await plugin.onload();

    plugin.settings.enableMetadataFiles = true;
    plugin.settings.metadataDirRegex = "^logs";
    await plugin.saveSettings();

    const openFileInLeafSpy = vi.fn(async () => {});
    env.app.workspace.getLeaf = vi.fn(() => ({ openFile: openFileInLeafSpy }));

    // Simulate Obsidian's bubble-phase click listener on `.nav-file-title` that opens the clicked file
    const nativeTreeClickSpy = vi.fn();
    logDom.titleEl.addEventListener("click", nativeTreeClickSpy, false);
    cDom.titleEl.addEventListener("click", nativeTreeClickSpy, false);

    const metaOpenSpy = vi.fn();
    plugin.eventBus.on("metadata:open-or-create", metaOpenSpy);

    // 1. Normal click on `logs/server.log` content element -> NOT intercepted; native click handler runs!
    const normalClickEvt = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    logDom.contentEl.dispatchEvent(normalClickEvt);
    expect(normalClickEvt.defaultPrevented).toBe(false);
    expect(nativeTreeClickSpy).toHaveBeenCalledTimes(1);
    expect(metaOpenSpy).not.toHaveBeenCalled();

    // 2. Alt+Click on `logs/server.log` content element -> intercepted in capture phase!
    // Native bubble listener does NOT run; `logs/server.md` is created and opened; `logs/server.log` gets underlined!
    nativeTreeClickSpy.mockClear();
    const altClickEvt = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      altKey: true,
    });
    logDom.contentEl.dispatchEvent(altClickEvt);
    expect(altClickEvt.defaultPrevented).toBe(true);
    expect(nativeTreeClickSpy).not.toHaveBeenCalled();

    // Wait for async companion creation and tree re-decoration
    await new Promise((r) => setTimeout(r, 15));

    expect(metaOpenSpy).toHaveBeenCalledTimes(1);
    expect(metaOpenSpy.mock.calls[0][0].targetFile).toBe(logFile);
    const createdCompanion = env.files.get("logs/server.md");
    expect(createdCompanion).toBeDefined();
    expect(openFileInLeafSpy).toHaveBeenCalledWith(createdCompanion);
    expect(
      logDom.titleEl.classList.contains("has-companion-metadata")
    ).toBe(true);

    // 3. Ctrl+Shift+Click on `logs/server.log` also intercepts in capture phase and opens existing `logs/server.md`
    openFileInLeafSpy.mockClear();
    const ctrlShiftClickEvt = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      shiftKey: true,
    });
    logDom.titleEl.dispatchEvent(ctrlShiftClickEvt);
    expect(ctrlShiftClickEvt.defaultPrevented).toBe(true);
    expect(nativeTreeClickSpy).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 15));
    expect(openFileInLeafSpy).toHaveBeenCalledWith(createdCompanion);

    // 4. Alt+Click on `src/main.c` (outside `^logs` regex) is NOT intercepted
    metaOpenSpy.mockClear();
    const ineligibleAltClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      altKey: true,
    });
    cDom.contentEl.dispatchEvent(ineligibleAltClick);
    expect(ineligibleAltClick.defaultPrevented).toBe(false);
    expect(nativeTreeClickSpy).toHaveBeenCalledTimes(1);
    expect(metaOpenSpy).not.toHaveBeenCalled();

    await plugin.onunload();
  });

  it("integrates file-menu context menu, command palette entry, and active view header button with companion metadata creation", async () => {
    const env = createTestVaultAndDomEnv();
    const logFile = env.addFile("logs/service.log", undefined, "INFO ready");
    const cFile = env.addFile("src/app.c", undefined, "int main() {}");
    const mdFile = env.addFile("logs/notes.md", undefined, "# Notes");
    const folder = new TFolder("logs");

    const logsFolder = env.addTreeFolderItem(env.navContainer, "logs");
    const logDom = env.addTreeFileItem(
      logsFolder.childrenEl,
      "logs/service.log"
    );

    const openFileInLeafSpy = vi.fn(async () => {});
    env.app.workspace.getLeaf = vi.fn(() => ({ openFile: openFileInLeafSpy }));

    const plugin = new FileSupportPlugin(env.app, createMockManifest());
    await plugin.onload();

    // Find registered command
    const command = (plugin as any)._commands.find(
      (c: any) => c.id === "open-or-create-companion-metadata"
    );
    expect(command).toBeDefined();
    expect(command.name).toBe(COMPANION_CONTEXT_MENU_TITLE);

    // 1. While companion metadata is disabled (default):
    // - file-menu does not add item
    const menuWhenDisabled = new Menu();
    env.app.workspace.trigger(
      "file-menu",
      menuWhenDisabled,
      logFile,
      "file-explorer"
    );
    expect(menuWhenDisabled.items.length).toBe(0);

    // - command checkCallback(true) returns false
    env.app.workspace.getActiveFile = vi.fn(() => logFile);
    expect(command.checkCallback(true)).toBe(false);

    // 2. Enable companion metadata for `^logs`
    plugin.settings.enableMetadataFiles = true;
    plugin.settings.metadataDirRegex = "^logs";
    await plugin.saveSettings();

    // - file-menu on ineligible file (`src/app.c`), `.md` file, or `TFolder` adds 0 items
    const menuIneligible = new Menu();
    env.app.workspace.trigger(
      "file-menu",
      menuIneligible,
      cFile,
      "file-explorer"
    );
    env.app.workspace.trigger(
      "file-menu",
      menuIneligible,
      mdFile,
      "file-explorer"
    );
    env.app.workspace.trigger(
      "file-menu",
      menuIneligible,
      folder,
      "file-explorer"
    );
    expect(menuIneligible.items.length).toBe(0);

    // - file-menu on eligible `logs/service.log` adds "Open/Create companion metadata note"
    const menuEligible = new Menu();
    env.app.workspace.trigger(
      "file-menu",
      menuEligible,
      logFile,
      "file-explorer"
    );
    expect(menuEligible.items.length).toBe(1);
    expect(menuEligible.items[0].title).toBe(COMPANION_CONTEXT_MENU_TITLE);
    expect(menuEligible.items[0].icon).toBe("file-symlink");

    // Clicking context menu item creates `logs/service.md`, opens it, and underlines `logs/service.log` in File Explorer
    menuEligible.items[0].triggerClick();
    await new Promise((r) => setTimeout(r, 15));

    const serviceCompanion = env.files.get("logs/service.md");
    expect(serviceCompanion).toBeDefined();
    expect(openFileInLeafSpy).toHaveBeenCalledWith(serviceCompanion);
    expect(
      logDom.titleEl.classList.contains("has-companion-metadata")
    ).toBe(true);

    // 3. Command palette entry:
    // - When active file is ineligible (`src/app.c`), checkCallback(true) returns false
    env.app.workspace.getActiveFile = vi.fn(() => cFile);
    expect(command.checkCallback(true)).toBe(false);

    // - When active file is eligible (`logs/service.log`), checkCallback(true) returns true
    //   and checkCallback(false) opens the companion note
    openFileInLeafSpy.mockClear();
    env.app.workspace.getActiveFile = vi.fn(() => logFile);
    expect(command.checkCallback(true)).toBe(true);
    expect(command.checkCallback(false)).toBe(true);
    await new Promise((r) => setTimeout(r, 15));
    expect(openFileInLeafSpy).toHaveBeenCalledWith(serviceCompanion);

    // 4. Active SupportedFileView header button:
    // - Eligible view (`logs/service.log`): header button is enabled (`is-disabled` = false)
    const logView = new SupportedFileView(createMockLeaf(), plugin);
    logView.onload();
    await logView.onLoadFile(logFile);
    const logHeaderBtn = logView.getMetadataActionElement()!;
    expect(logHeaderBtn.classList.contains("is-disabled")).toBe(false);
    expect(logHeaderBtn.getAttribute("aria-disabled")).toBe("false");

    // - Ineligible view (`src/app.c` outside `^logs`): header button is marked disabled (`is-disabled` = true)
    const cView = new SupportedFileView(createMockLeaf(), plugin);
    cView.onload();
    await cView.onLoadFile(cFile);
    const cHeaderBtn = cView.getMetadataActionElement()!;
    expect(cHeaderBtn.classList.contains("is-disabled")).toBe(true);
    expect(cHeaderBtn.getAttribute("aria-disabled")).toBe("true");

    logView.onunload();
    cView.onunload();

    // 5. Unloading plugin strips all File Explorer badges and companion classes cleanly
    await plugin.onunload();
    expect(env.navContainer.querySelectorAll(".file-support-badge").length).toBe(
      0
    );
    expect(
      logDom.titleEl.classList.contains("has-companion-metadata")
    ).toBe(false);
    expect(env.app.workspace.listenerCount("layout-change")).toBe(0);
    expect(env.app.workspace.listenerCount("file-menu")).toBe(0);
  });

  it("does not run a full File Explorer redecorate on metadataCache resolved and only path-filters changed/deleted passes", async () => {
    const env = createTestVaultAndDomEnv();
    env.addFile("logs/server.log");
    env.addFile("logs/other.log");
    const logsFolder = env.addTreeFolderItem(env.navContainer, "logs");
    env.addTreeFileItem(logsFolder.childrenEl, "logs/server.log");
    env.addTreeFileItem(logsFolder.childrenEl, "logs/other.log");

    const plugin = new FileSupportPlugin(env.app, createMockManifest());
    await plugin.onload();
    plugin.settings.enableMetadataFiles = true;
    plugin.settings.metadataDirRegex = "^logs";
    await plugin.saveSettings();

    expect(env.app.metadataCache.listenerCount("resolved")).toBe(0);

    const treeDecorateSpy = vi.fn();
    plugin.eventBus.on("tree:decorate", treeDecorateSpy);

    // 1. Firing `resolved` (Obsidian does this after every metadata change once indexing is done)
    //    must NOT trigger any full-tree redecorate pass
    env.app.metadataCache.trigger("resolved");
    await new Promise((r) => setTimeout(r, 25));
    expect(treeDecorateSpy).not.toHaveBeenCalled();

    // 2. A `changed` event for a single file triggers exactly one pass scoped to that path
    const serverLog = env.files.get("logs/server.log")!;
    env.app.metadataCache.trigger("changed", serverLog);
    await new Promise((r) => setTimeout(r, 25));
    expect(treeDecorateSpy).toHaveBeenCalledTimes(1);
    expect(treeDecorateSpy.mock.calls[0][0].filePaths).toEqual([
      "logs/server.log",
    ]);

    await plugin.onunload();
  });

  it("removes a plugin-injected .nav-file-tag badge when a native .nav-file-tag is appended to the same title later", async () => {
    const env = createTestVaultAndDomEnv();
    env.addFile("logs/server.log");
    const logsFolder = env.addTreeFolderItem(env.navContainer, "logs");
    const logDom = env.addTreeFileItem(logsFolder.childrenEl, "logs/server.log");

    const plugin = new FileSupportPlugin(env.app, createMockManifest());
    await plugin.onload();

    // Plugin badge is injected first (no native badge existed yet)
    expect(logDom.titleEl.querySelectorAll(".nav-file-tag").length).toBe(1);
    expect(
      logDom.titleEl
        .querySelector(".nav-file-tag")
        ?.classList.contains("file-support-badge")
    ).toBe(true);

    // Obsidian later appends its own native `.nav-file-tag` to the same title
    const nativeTag = document.createElement("div");
    nativeTag.className = "nav-file-tag";
    nativeTag.textContent = "LOG";
    logDom.titleEl.appendChild(nativeTag);

    await new Promise((r) => setTimeout(r, 25));

    // The plugin duplicate is removed; only the native tag remains
    const tags = logDom.titleEl.querySelectorAll(".nav-file-tag");
    expect(tags.length).toBe(1);
    expect(tags[0]).toBe(nativeTag);
    expect(tags[0].classList.contains("file-support-badge")).toBe(false);

    await plugin.onunload();
  });
});
