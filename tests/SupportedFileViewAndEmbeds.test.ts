import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import {
  createMockApp,
  createMockLeaf,
  createMockManifest,
  createMockTFile,
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
    expect(app.vault.modify).toHaveBeenCalledWith(
      cFile,
      "#include <stdio.h>\nint main() { return 0; }\n// edited"
    );

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
    actionEl.dispatchEvent({ type: "click" });
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

    // Editing inside the now-editable embed saves changes via vault.modify
    embedInstance.view.dispatch({
      changes: { from: embedInstance.getValue().length, insert: "\nFIXED" },
    });
    expect(app.vault.modify).toHaveBeenCalledWith(
      logFile,
      "2026-11-15 WARN Disk 90%\nFIXED"
    );

    // 4. Disabling .log in settings forces both open view and embed back to readonly
    await plugin.updateFileTypeConfig("log", { enabled: false });
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

  it("handles ![[file]] in Live Preview via CM6 editor extension fallback and cleans up on edit/destroy", async () => {
    const app = createMockApp() as any;
    const logFile = createMockTFile("logs/build.log");
    app.metadataCache.getFirstLinkpathDest = vi.fn((linkpath: string) =>
      linkpath === "logs/build.log" || linkpath === "build.log" ? logFile : null
    );
    app.vault.read = vi.fn(async () => "BUILD SUCCESSFUL in 2s");

    const plugin = new FileSupportPlugin(app, createMockManifest());
    await plugin.onload();

    expect((plugin as any)._editorExtensions.length).toBe(1);

    const hostParent = document.createElement("div");
    const lpState = EditorState.create({
      doc: "# Build Report\n![[logs/build.log]]\nDone.",
      extensions: [
        createLivePreviewEmbedExtension(plugin, {
          sourcePath: "notes/report.md",
          forceFallback: true,
        }),
      ],
    });

    const lpView = new EditorView({
      state: lpState,
      parent: hostParent,
    });

    const lpEmbedEl = hostParent.querySelector(
      ".file-support-lp-embed"
    ) as any;
    expect(lpEmbedEl).not.toBeNull();

    const embeddedWidget: FileEmbedWidget = lpEmbedEl.__fileSupportEmbedWidget;
    expect(embeddedWidget).toBeDefined();
    await embeddedWidget.loadFile();

    expect(embeddedWidget.getRendererInstance()?.getValue()).toBe(
      "BUILD SUCCESSFUL in 2s"
    );
    expect(embeddedWidget.getMode()).toBe("readonly");
    expect(plugin.textCodeRendererMiddleware.getActiveInstanceCount()).toBe(1);

    // Removing the ![[logs/build.log]] line from the Live Preview document destroys the embed widget cleanly
    lpView.dispatch({
      changes: {
        from: 0,
        to: lpView.state.doc.length,
        insert: "# Build Report\nNo embeds here.",
      },
    });

    expect(hostParent.querySelector(".file-support-lp-embed")).toBeNull();
    expect(plugin.textCodeRendererMiddleware.getActiveInstanceCount()).toBe(0);

    lpView.destroy();
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
