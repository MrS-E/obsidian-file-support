import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import {
  createMockApp,
  createMockLeaf,
  createMockManifest,
  createMockTFile,
  editorInfoField,
  editorLivePreviewField,
  setLivePreviewEffect,
} from "./__mocks__/obsidian";
import {
  FileEmbedWidget,
  createLivePreviewEmbedExtension,
  processMarkdownEmbeds,
} from "../src/embeds/FileEmbedWidget";
import FileSupportPlugin from "../src/main";
import type { CM6RendererInstance } from "../src/renderers/cm6/CM6EditorFactory";
import {
  SupportedFileView,
  VIEW_TYPE_FILE_SUPPORT,
} from "../src/views/SupportedFileView";

describe("SupportedFileView, FileEmbedWidget, and Live Config Reconfiguration", () => {
  it("opens editable tabs for code/txt and read-only tabs for log/patch/diff, enforcing read-only on save and edits", async () => {
    const app = createMockApp() as any;
    const files: Record<string, string> = {
      "src/main.c": "#include <stdio.h>\nint main() { return 0; }",
      "logs/server.log": "2026-11-15 INFO Server started",
      "fixes/bug.patch": "--- a/main.c\n+++ b/main.c",
    };
    app.vault.read = vi.fn(async (file: any) => files[file.path] ?? "");
    app.vault.modify = vi.fn(async (file: any, data: string) => {
      files[file.path] = data;
    });

    const plugin = new FileSupportPlugin(app, createMockManifest());
    await plugin.onload();

    // 1. Open main.c in SupportedFileView -> editable by default
    const cLeaf = createMockLeaf();
    const cView = new SupportedFileView(cLeaf, plugin);
    cView.onload();
    const cFile = createMockTFile("src/main.c") as any;
    await cView.onLoadFile(cFile);

    expect(cView.getViewType()).toBe(VIEW_TYPE_FILE_SUPPORT);
    expect(cView.getDisplayText()).toBe("main.c");
    expect(cView.getMode()).toBe("editable");

    const cCmInstance = cView.getRendererInstance() as CM6RendererInstance;
    expect(cCmInstance).toBeDefined();
    expect(cCmInstance.isReadOnly()).toBe(false);

    // Edit in CM6 editor -> triggers requestSave and updates getViewData()
    const requestSaveSpy = vi.spyOn(cView, "requestSave");
    cCmInstance.view.dispatch({
      changes: {
        from: cCmInstance.getValue().length,
        insert: "\n// edited",
      },
    });
    expect(requestSaveSpy).toHaveBeenCalledTimes(1);
    expect(cView.getViewData()).toContain("// edited");

    await cView.save();
    expect(app.vault.modify).toHaveBeenCalledTimes(1);
    expect(app.vault.modify).toHaveBeenCalledWith(
      cFile,
      "#include <stdio.h>\nint main() { return 0; }\n// edited"
    );

    // Calling save() again when no further edits were made skips redundant vault.modify
    await cView.save();
    expect(app.vault.modify).toHaveBeenCalledTimes(1);

    // 2. Open server.log in SupportedFileView -> readonly by default
    const logLeaf = createMockLeaf();
    const logView = new SupportedFileView(logLeaf, plugin);
    logView.onload();
    const logFile = createMockTFile("logs/server.log") as any;
    await logView.onLoadFile(logFile);

    expect(logView.getMode()).toBe("readonly");
    const logCmInstance = logView.getRendererInstance() as CM6RendererInstance;
    expect(logCmInstance.isReadOnly()).toBe(true);

    // Attempt to edit read-only log editor -> rejected by CM6 transactionFilter
    app.vault.modify.mockClear();
    logCmInstance.view.dispatch({
      changes: { from: 0, insert: "TAMPERED " },
    });
    expect(logView.getViewData()).toBe("2026-11-15 INFO Server started");

    // Calling save() on read-only view does not modify vault file
    await logView.save();
    expect(app.vault.modify).not.toHaveBeenCalled();

    // 3. View header action button emits metadata:open-or-create
    const metaOpenSpy = vi.fn();
    plugin.eventBus.on("metadata:open-or-create", metaOpenSpy);
    const actionEl = logView.getMetadataActionElement() as any;
    expect(actionEl).toBeDefined();
    actionEl.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    expect(metaOpenSpy).toHaveBeenCalledTimes(1);
    expect(metaOpenSpy.mock.calls[0][0].targetFile).toBe(logFile);

    cView.onunload();
    logView.onunload();
    await plugin.onunload();
  });

  it("live-reconfigures open views and embeds on config:updated and avoids needless rerenders on unrelated setting changes", async () => {
    const app = createMockApp() as any;
    app.vault.read = vi.fn(async () => "2026-11-15 WARN Disk 90%");
    app.vault.modify = vi.fn(async () => {});

    const plugin = new FileSupportPlugin(app, createMockManifest());
    await plugin.onload();

    const logFile = createMockTFile("logs/app.log") as any;

    // Open a tab view and an inline embed for app.log
    const view = new SupportedFileView(createMockLeaf(), plugin);
    view.onload();
    await view.onLoadFile(logFile);

    const embedContainer = document.createElement("div");
    const embed = new FileEmbedWidget({
      app,
      plugin,
      containerEl: embedContainer,
      file: logFile,
    });
    embed.load();
    await embed.loadFile();

    const viewInstance = view.getRendererInstance() as CM6RendererInstance;
    const embedInstance = embed.getRendererInstance() as CM6RendererInstance;
    expect(viewInstance.getMode()).toBe("readonly");
    expect(embedInstance.getMode()).toBe("readonly");

    const viewSetModeSpy = vi.spyOn(viewInstance, "setMode");
    const embedSetModeSpy = vi.spyOn(embedInstance, "setMode");

    // 1. Unrelated setting keystrokes (metadataDirRegex, metadataFrontmatterKey, enableMetadataFiles)
    // and unrelated extension changes (.json) must NOT call setMode or remount the .log editors
    plugin.settings.metadataDirRegex = "^logs/";
    await plugin.saveSettings();
    plugin.settings.metadataFrontmatterKey = "target-file";
    await plugin.saveSettings();
    await plugin.updateFileTypeConfig("json", { tabMode: "readonly" });
    // Updating badgeLabel on .log itself updates the embed badge text without reconfiguring CM6 mode
    await plugin.updateFileTypeConfig("log", { badgeLabel: "SYSLOG" });

    expect(viewSetModeSpy).not.toHaveBeenCalled();
    expect(embedSetModeSpy).not.toHaveBeenCalled();
    expect(view.getRendererInstance()).toBe(viewInstance);
    expect(embed.getRendererInstance()).toBe(embedInstance);
    expect(
      embedContainer.querySelector(".file-support-badge")?.textContent
    ).toBe("SYSLOG");

    // 2. Toggle .log tabMode to 'editable' -> only the tab view reconfigures its CM6 compartment
    await plugin.updateFileTypeConfig("log", { tabMode: "editable" });
    expect(viewSetModeSpy).toHaveBeenCalledTimes(1);
    expect(viewSetModeSpy).toHaveBeenLastCalledWith("editable");
    expect(viewInstance.isReadOnly()).toBe(false);
    expect(embedSetModeSpy).not.toHaveBeenCalled();
    expect(embedInstance.isReadOnly()).toBe(true);

    // 3. Toggle .log embedMode to 'editable' -> only the embed reconfigures its CM6 compartment
    await plugin.updateFileTypeConfig("log", { embedMode: "editable" });
    expect(embedSetModeSpy).toHaveBeenCalledTimes(1);
    expect(embedSetModeSpy).toHaveBeenLastCalledWith("editable");
    expect(embedInstance.isReadOnly()).toBe(false);

    // Editing inside the now-editable embed saves changes via debounced vault.modify
    // and flushes automatically when disabling .log transitions the embed back to readonly
    embedInstance.view.dispatch({
      changes: { from: embedInstance.getValue().length, insert: "\nFIXED" },
    });

    // 4. Disabling .log in settings flushes the pending embed edit and forces both open view and embed back to readonly
    await plugin.updateFileTypeConfig("log", { enabled: false });
    expect(app.vault.modify).toHaveBeenCalledWith(
      logFile,
      "2026-11-15 WARN Disk 90%\nFIXED"
    );
    expect(viewInstance.isReadOnly()).toBe(true);
    expect(embedInstance.isReadOnly()).toBe(true);

    embed.unload();
    view.onunload();
    await plugin.onunload();
  });

  it("integrates with Obsidian app.embedRegistry with conflict guards and clean unload", async () => {
    const app = createMockApp() as any;
    app.vault.read = vi.fn(async () => "puts 'hello ruby'");

    const existingJsonHandler = vi.fn();
    const embedByExtension: Record<string, any> = {
      json: existingJsonHandler, // Simulate another plugin already owning .json in embedRegistry
    };

    app.embedRegistry = {
      embedByExtension,
      registerExtensions: vi.fn((exts: string[], creator: any) => {
        for (const ext of exts) {
          embedByExtension[ext] = creator;
        }
      }),
      unregisterExtensions: vi.fn((exts: string[]) => {
        for (const ext of exts) {
          delete embedByExtension[ext];
        }
      }),
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const plugin = new FileSupportPlugin(app, createMockManifest());
    await plugin.onload();

    // .json was skipped without overwriting existingJsonHandler
    expect(embedByExtension.json).toBe(existingJsonHandler);
    expect(plugin.isExtensionRegisteredInEmbedRegistry("json")).toBe(false);
    // .rb and .log were registered
    expect(typeof embedByExtension.rb).toBe("function");
    expect(plugin.isExtensionRegisteredInEmbedRegistry("rb")).toBe(true);

    // Invoke the registered embed creator as Obsidian does (`load()` + `loadFile()`)
    const rbFile = createMockTFile("scripts/app.rb");
    const hostEl = document.createElement("div");
    const widget = embedByExtension.rb(
      { app, containerEl: hostEl, sourcePath: "notes/index.md" },
      rbFile,
      ""
    );
    widget.load();
    await widget.loadFile();

    expect(widget.getMode()).toBe("readonly");
    expect(widget.getRendererInstance()?.getValue()).toBe("puts 'hello ruby'");
    expect(
      hostEl.querySelector(".file-support-embed-title")?.textContent
    ).toBe("app.rb");
    expect(hostEl.querySelector(".file-support-badge")?.textContent).toBe("RB");

    // Test "Open file" and "Open metadata" header buttons on embed
    const leafOpenFileSpy = vi.fn(async () => {});
    app.workspace.getLeaf = vi.fn(() => ({ openFile: leafOpenFileSpy }));
    const metaSpy = vi.fn();
    plugin.eventBus.on("metadata:open-or-create", metaSpy);

    widget.getOpenFileButton()?.click();
    expect(leafOpenFileSpy).toHaveBeenCalledWith(rbFile);

    widget.getMetadataButton()?.click();
    await Promise.resolve();
    expect(metaSpy).toHaveBeenCalledTimes(1);
    expect(metaSpy.mock.calls[0][0].targetFile).toBe(rbFile);

    // Disabling .rb unregisters it from embedRegistry
    await plugin.updateFileTypeConfig("rb", { enabled: false });
    expect(embedByExtension.rb).toBeUndefined();
    expect(plugin.isExtensionRegisteredInEmbedRegistry("rb")).toBe(false);

    // Unloading plugin unregisters all remaining plugin-owned extensions while leaving .json intact
    await plugin.onunload();
    expect(embedByExtension.log).toBeUndefined();
    expect(embedByExtension.json).toBe(existingJsonHandler);
    warnSpy.mockRestore();
  });

  it("handles ![[file]] in Reading Mode via registerMarkdownPostProcessor fallback (both .internal-embed and raw syntax)", async () => {
    const app = createMockApp() as any;
    const patchFile = createMockTFile("patches/fix.patch");
    const cFile = createMockTFile("src/engine.c");

    const fileMap: Record<string, any> = {
      "patches/fix.patch": patchFile,
      "fix.patch": patchFile,
      "src/engine.c": cFile,
      "engine.c": cFile,
    };
    const fileContents: Record<string, string> = {
      "patches/fix.patch": "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new",
      "src/engine.c": "void init() {}\nvoid tick() {}\nvoid shutdown() {}",
    };

    app.metadataCache.getFirstLinkpathDest = vi.fn(
      (linkpath: string) => fileMap[linkpath] ?? null
    );
    app.vault.read = vi.fn(
      async (file: any) => fileContents[file.path] ?? ""
    );

    const plugin = new FileSupportPlugin(app, createMockManifest());
    await plugin.onload();

    // Case A: Reading Mode DOM with `.internal-embed` span created by Obsidian
    const sectionEl = document.createElement("div");
    const internalEmbedSpan = document.createElement("span");
    internalEmbedSpan.className = "internal-embed";
    internalEmbedSpan.setAttribute("src", "patches/fix.patch");
    sectionEl.appendChild(internalEmbedSpan);

    const childComponents: any[] = [];
    const ctx: any = {
      docId: "doc-1",
      sourcePath: "notes/review.md",
      frontmatter: null,
      addChild: vi.fn((child: any) => {
        childComponents.push(child);
        child.load();
      }),
      getSectionInfo: () => null,
    };

    const widgetsA = await processMarkdownEmbeds(sectionEl, ctx, plugin);
    expect(widgetsA.length).toBe(1);
    expect(ctx.addChild).toHaveBeenCalledTimes(1);
    expect(widgetsA[0].getRendererInstance()?.getValue()).toContain("+new");
    expect(widgetsA[0].getMode()).toBe("readonly");

    // Re-running post-processor on the same element does not double-mount
    const widgetsDuplicate = await processMarkdownEmbeds(sectionEl, ctx, plugin);
    expect(widgetsDuplicate.length).toBe(0);

    // Case B: Raw `![[src/engine.c#L2]]` syntax in a post-processed block
    const rawBlockEl = document.createElement("p");
    rawBlockEl.textContent = "See inline: ![[src/engine.c#L2]]";
    const widgetsB = await processMarkdownEmbeds(rawBlockEl, ctx, plugin);
    expect(widgetsB.length).toBe(1);
    expect(widgetsB[0].getRendererInstance()?.getValue()).toBe("void tick() {}");

    for (const c of childComponents) {
      c.unload();
    }
    await plugin.onunload();
  });

  it("handles ![[file]] in Live Preview via CM6 editor extension (gated on editorLivePreviewField, editorInfoField, and native registry skip)", async () => {
    const app = createMockApp() as any;
    const logFile = createMockTFile("notes/sub/build.log");
    const rbFile = createMockTFile("notes/sub/script.rb");
    const noteFile = createMockTFile("notes/sub/report.md");
    const unrelatedActiveFile = createMockTFile("other/unrelated.md");

    // Simulate workspace.getActiveFile returning an unrelated note from another pane
    app.workspace.getActiveFile = vi.fn(() => unrelatedActiveFile);
    app.workspace.activeEditor = null;

    // Resolve relative linkpaths only when sourcePath matches notes/sub/report.md
    app.metadataCache.getFirstLinkpathDest = vi.fn(
      (linkpath: string, sourcePath: string) => {
        if (sourcePath === "notes/sub/report.md") {
          if (linkpath === "build.log") return logFile;
          if (linkpath === "script.rb") return rbFile;
        }
        return null;
      }
    );
    app.vault.read = vi.fn(async (file: any) =>
      file.path === "notes/sub/build.log"
        ? "BUILD SUCCESSFUL in 2s"
        : "puts 'from rb'"
    );

    const plugin = new FileSupportPlugin(app, createMockManifest());
    await plugin.onload();

    expect((plugin as any)._editorExtensions.length).toBe(1);

    const hostParent = document.createElement("div");

    // 1. In Source mode (editorLivePreviewField = false), no embed widgets are rendered
    const sourceState = EditorState.create({
      doc: "# Build Report\n![[build.log]]\nDone.",
      extensions: [
        editorLivePreviewField.init(() => false),
        editorInfoField.init(() => ({ app, file: noteFile })),
        createLivePreviewEmbedExtension(plugin),
      ],
    });

    const lpView = new EditorView({
      state: sourceState,
      parent: hostParent,
    });

    expect(hostParent.querySelector(".file-support-lp-embed")).toBeNull();
    expect(plugin.textCodeRendererMiddleware.getActiveInstanceCount()).toBe(0);

    // 2. Toggle editor to Live Preview mode (editorLivePreviewField = true) -> mounts embed using editorInfoField sourcePath
    lpView.dispatch({
      effects: setLivePreviewEffect.of(true),
    });

    const lpEmbedEl = hostParent.querySelector(
      ".file-support-lp-embed"
    ) as any;
    expect(lpEmbedEl).not.toBeNull();

    const embeddedWidget: FileEmbedWidget = lpEmbedEl.__fileSupportEmbedWidget;
    expect(embeddedWidget).toBeDefined();
    expect(embeddedWidget.sourcePath).toBe("notes/sub/report.md");
    await embeddedWidget.loadFile();

    expect(embeddedWidget.getRendererInstance()?.getValue()).toBe(
      "BUILD SUCCESSFUL in 2s"
    );
    expect(embeddedWidget.getMode()).toBe("readonly");
    expect(plugin.textCodeRendererMiddleware.getActiveInstanceCount()).toBe(1);

    // 3. When an extension (.rb) is registered in native embedRegistry, both Live Preview
    // (even with workspace.activeEditor === null) and Reading Mode post-processor skip it
    vi.spyOn(
      plugin,
      "isExtensionRegisteredInEmbedRegistry"
    ).mockImplementation((ext: string) => ext === "rb");

    lpView.dispatch({
      changes: {
        from: 0,
        to: lpView.state.doc.length,
        insert: "# Build Report\n![[build.log]]\n![[script.rb]]\nDone.",
      },
    });

    const allLpEmbeds = hostParent.querySelectorAll(".file-support-lp-embed");
    expect(allLpEmbeds.length).toBe(1);
    expect(allLpEmbeds[0].getAttribute("src")).toBe("notes/sub/build.log");

    // Reading Mode post-processor also skips native-registered .rb while mounting non-native .log
    const readingSectionEl = document.createElement("div");
    const rbSpan = document.createElement("span");
    rbSpan.className = "internal-embed";
    rbSpan.setAttribute("src", "script.rb");
    readingSectionEl.appendChild(rbSpan);

    const logSpan = document.createElement("span");
    logSpan.className = "internal-embed";
    logSpan.setAttribute("src", "build.log");
    readingSectionEl.appendChild(logSpan);

    const readingCtx: any = {
      docId: "doc-lp",
      sourcePath: "notes/sub/report.md",
      frontmatter: null,
      addChild: vi.fn((child: any) => child.load()),
      getSectionInfo: () => null,
    };

    const readingWidgets = await processMarkdownEmbeds(
      readingSectionEl,
      readingCtx,
      plugin
    );
    expect(readingWidgets.length).toBe(1);
    expect(readingWidgets[0].file.path).toBe("notes/sub/build.log");
    expect(rbSpan.getAttribute("data-file-support-mounted")).toBeNull();
    readingWidgets[0].unload();

    // 4. Switching back to Source mode unmounts the Live Preview embed widget cleanly
    lpView.dispatch({
      effects: setLivePreviewEffect.of(false),
    });
    expect(hostParent.querySelector(".file-support-lp-embed")).toBeNull();
    expect(plugin.textCodeRendererMiddleware.getActiveInstanceCount()).toBe(0);

    lpView.destroy();
    await plugin.onunload();
  });

  it("flushes pending dirty tab edits before switching to read-only or disabling the extension", async () => {
    const app = createMockApp() as any;
    const files: Record<string, string> = {
      "src/app.c": "int x = 1;",
    };
    app.vault.read = vi.fn(async (file: any) => files[file.path] ?? "");
    app.vault.modify = vi.fn(async (file: any, data: string) => {
      files[file.path] = data;
    });

    const plugin = new FileSupportPlugin(app, createMockManifest());
    await plugin.onload();

    const cFile = createMockTFile("src/app.c") as any;
    const view = new SupportedFileView(createMockLeaf(), plugin);
    view.onload();
    await view.onLoadFile(cFile);

    const cmInstance = view.getRendererInstance() as CM6RendererInstance;
    expect(view.getMode()).toBe("editable");

    // 1. User edits in the tab (requestSave debounce is pending, save() not called yet)
    cmInstance.view.dispatch({
      changes: { from: cmInstance.getValue().length, insert: "\nint y = 2;" },
    });
    expect(app.vault.modify).not.toHaveBeenCalled();

    // Flip .c tabMode from editable -> readonly: flushes save() before locking editor
    await plugin.updateFileTypeConfig("c", { tabMode: "readonly" });
    expect(app.vault.modify).toHaveBeenCalledTimes(1);
    expect(app.vault.modify).toHaveBeenLastCalledWith(
      cFile,
      "int x = 1;\nint y = 2;"
    );
    expect(view.getMode()).toBe("readonly");
    expect(cmInstance.isReadOnly()).toBe(true);

    // 2. Flip .c back to editable, make another edit, then disable .c extension -> also flushes save()
    await plugin.updateFileTypeConfig("c", { tabMode: "editable" });
    expect(view.getMode()).toBe("editable");

    cmInstance.view.dispatch({
      changes: { from: cmInstance.getValue().length, insert: "\nint z = 3;" },
    });
    expect(app.vault.modify).toHaveBeenCalledTimes(1);

    await plugin.updateFileTypeConfig("c", { enabled: false });
    expect(app.vault.modify).toHaveBeenCalledTimes(2);
    expect(app.vault.modify).toHaveBeenLastCalledWith(
      cFile,
      "int x = 1;\nint y = 2;\nint z = 3;"
    );
    expect(view.getMode()).toBe("readonly");
    expect(cmInstance.isReadOnly()).toBe(true);

    view.onunload();
    await plugin.onunload();
  });

  it("forces subpath embeds (#L2-L4) to read-only even when embedMode is editable", async () => {
    const app = createMockApp() as any;
    const cFile = createMockTFile("src/module.c") as any;
    const originalContent = ["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n");
    app.vault.read = vi.fn(async () => originalContent);
    app.vault.modify = vi.fn(async () => {});

    const plugin = new FileSupportPlugin(app, createMockManifest());
    await plugin.onload();

    // Configure .c embeds to be editable
    await plugin.updateFileTypeConfig("c", { embedMode: "editable" });

    // Mount a subpath embed ![[src/module.c#L2-L4]]
    const containerEl = document.createElement("div");
    const subpathEmbed = new FileEmbedWidget({
      app,
      plugin,
      containerEl,
      file: cFile,
      subpath: "#L2-L4",
    });
    subpathEmbed.load();
    await subpathEmbed.loadFile();

    const cmInstance = subpathEmbed.getRendererInstance() as CM6RendererInstance;
    expect(subpathEmbed.getMode()).toBe("readonly");
    expect(cmInstance.getMode()).toBe("readonly");
    expect(cmInstance.isReadOnly()).toBe(true);
    expect(cmInstance.getValue()).toBe("line 2\nline 3\nline 4");
    expect(
      containerEl.querySelector(".file-support-embed-mode")?.textContent
    ).toBe("Read-only");
    expect(
      containerEl
        .querySelector(".file-support-embed-mode")
        ?.getAttribute("data-edit-mode")
    ).toBe("readonly");

    // Attempt to dispatch an edit in the subpath embed -> blocked by readOnly compartment
    cmInstance.view.dispatch({
      changes: { from: 0, insert: "EDITED " },
    });
    expect(cmInstance.getValue()).toBe("line 2\nline 3\nline 4");
    expect(app.vault.modify).not.toHaveBeenCalled();

    // Triggering a config update with embedMode: 'editable' still keeps subpath embed read-only
    await plugin.updateFileTypeConfig("c", { badgeLabel: "C99", embedMode: "editable" });
    expect(subpathEmbed.getMode()).toBe("readonly");
    expect(cmInstance.isReadOnly()).toBe(true);
    expect(
      containerEl.querySelector(".file-support-embed-mode")?.textContent
    ).toBe("Read-only");

    subpathEmbed.unload();
    await plugin.onunload();
  });

  it("debounces and serializes editable embed saves, refreshes on external vault modify without clobbering dirty edits, and cleans up subscriptions", async () => {
    const app = createMockApp() as any;
    const txtFile = createMockTFile("notes/todo.txt") as any;
    let diskContent = "initial";

    let pendingWriteResolvers: Array<() => void> = [];
    let interceptWrites = false;
    let activeWriteCount = 0;
    let maxConcurrentWrites = 0;

    app.vault.read = vi.fn(async () => diskContent);
    app.vault.modify = vi.fn(async (_file: any, newData: string) => {
      activeWriteCount++;
      maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWriteCount);
      if (interceptWrites) {
        await new Promise<void>((resolve) => {
          pendingWriteResolvers.push(resolve);
        });
      }
      diskContent = newData;
      activeWriteCount--;
    });

    const plugin = new FileSupportPlugin(app, createMockManifest());
    await plugin.onload();
    await plugin.updateFileTypeConfig("txt", { embedMode: "editable" });

    const containerEl = document.createElement("div");
    const embed = new FileEmbedWidget({
      app,
      plugin,
      containerEl,
      file: txtFile,
    });
    embed.load();
    await embed.loadFile();

    expect(app.vault.listenerCount("modify")).toBe(1);

    const cmInstance = embed.getRendererInstance() as CM6RendererInstance;
    expect(cmInstance.getMode()).toBe("editable");
    expect(cmInstance.getValue()).toBe("initial");

    // 1. External vault modify while embed is clean refreshes the embed editor via setValue
    diskContent = "updated externally";
    app.vault.trigger("modify", txtFile);
    await new Promise((r) => setTimeout(r, 10));
    expect(cmInstance.getValue()).toBe("updated externally");
    expect(app.vault.modify).not.toHaveBeenCalled();

    // 2. Rapid keystrokes are coalesced by the debounce timer into a single vault.modify call
    cmInstance.view.dispatch({
      changes: { from: cmInstance.getValue().length, insert: " 1" },
    });
    cmInstance.view.dispatch({
      changes: { from: cmInstance.getValue().length, insert: " 2" },
    });
    cmInstance.view.dispatch({
      changes: { from: cmInstance.getValue().length, insert: " 3" },
    });
    expect(app.vault.modify).not.toHaveBeenCalled();

    // 3. While embed has pending dirty edits (before debounce timer expires),
    // an external vault modify event MUST NOT clobber the user's dirty edits in the editor
    diskContent = "conflicting external change";
    app.vault.trigger("modify", txtFile);
    await new Promise((r) => setTimeout(r, 10));
    expect(cmInstance.getValue()).toBe("updated externally 1 2 3");

    // Flush the debounced save -> only 1 vault.modify call occurred for all 3 keystrokes
    await embed.flushSave();
    expect(app.vault.modify).toHaveBeenCalledTimes(1);
    expect(app.vault.modify).toHaveBeenLastCalledWith(
      txtFile,
      "updated externally 1 2 3"
    );
    expect(diskContent).toBe("updated externally 1 2 3");

    // 3b. Also verify natural debounce timer expiration (without manual flushSave) and
    // conflict guard when an async vault.read from external modify resolves after user types
    const slowReadResolvers: Array<(val: string) => void> = [];
    app.vault.read = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          slowReadResolvers.push(resolve);
        })
    );
    app.vault.trigger("modify", txtFile);
    // User types while external modify's vault.read is still in-flight
    cmInstance.view.dispatch({
      changes: { from: cmInstance.getValue().length, insert: " 4" },
    });
    // Now external modify's slow vault.read resolves with stale/conflicting data -> must NOT clobber " 4"
    slowReadResolvers.shift()?.("stale async read");
    await new Promise((r) => setTimeout(r, 10));
    expect(cmInstance.getValue()).toBe("updated externally 1 2 3 4");

    // Wait for natural debounce timer (150ms) to persist "updated externally 1 2 3 4"
    await new Promise((r) => setTimeout(r, 180));
    expect(app.vault.modify).toHaveBeenCalledTimes(2);
    expect(diskContent).toBe("updated externally 1 2 3 4");
    app.vault.read = vi.fn(async () => diskContent);

    // 4. Slow async writes are serialized and never execute concurrently
    app.vault.modify.mockClear();
    interceptWrites = true;

    // Start Write #1
    cmInstance.view.dispatch({
      changes: { from: cmInstance.getValue().length, insert: " A" },
    });
    const firstSavePromise = embed.flushSave();
    expect(app.vault.modify).toHaveBeenCalledTimes(1);
    expect(activeWriteCount).toBe(1);

    // While Write #1 is still in-flight, user types " B" and " C" and debounce expires
    cmInstance.view.dispatch({
      changes: { from: cmInstance.getValue().length, insert: " B" },
    });
    cmInstance.view.dispatch({
      changes: { from: cmInstance.getValue().length, insert: " C" },
    });
    const secondSavePromise = embed.flushSave();

    // Second write has NOT started yet while first write is in flight
    expect(app.vault.modify).toHaveBeenCalledTimes(1);
    expect(maxConcurrentWrites).toBe(1);

    // Resolve Write #1 -> Write #2 now starts with coalesced " B C"
    pendingWriteResolvers.shift()?.();
    await new Promise((r) => setTimeout(r, 10));
    expect(app.vault.modify).toHaveBeenCalledTimes(2);
    expect(maxConcurrentWrites).toBe(1);

    // Resolve Write #2
    pendingWriteResolvers.shift()?.();
    await Promise.all([firstSavePromise, secondSavePromise]);
    expect(diskContent).toBe("updated externally 1 2 3 4 A B C");
    expect(maxConcurrentWrites).toBe(1);

    // 5. Unloading the embed cleans up the vault.on('modify') subscription
    embed.unload();
    expect(app.vault.listenerCount("modify")).toBe(0);

    await plugin.onunload();
  });

  it("survives extension registration conflicts without crashing onload()", async () => {
    const app = createMockApp() as any;
    const plugin = new FileSupportPlugin(app, createMockManifest());
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.spyOn(plugin, "registerExtensions").mockImplementation(
      (exts: string[]) => {
        if (exts.includes("json")) {
          throw new Error('Extension "json" is already registered');
        }
      }
    );

    await expect(plugin.onload()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
    await plugin.onunload();
  });
});
