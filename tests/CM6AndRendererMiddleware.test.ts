import { describe, expect, it, vi } from "vitest";
import {
  createMockApp,
  createMockElement,
  createMockTFile,
} from "./__mocks__/obsidian";
import { EventBus } from "../src/core/EventBus";
import { FileTypeRegistry } from "../src/core/FileTypeRegistry";
import {
  TextCodeRendererMiddleware,
  registerRendererMiddleware,
} from "../src/middlewares/TextCodeRendererMiddleware";
import { RendererRegistry } from "../src/renderers/RendererRegistry";
import {
  CM6EditorFactory,
  applySubpathToContent,
  parseLineRangeSubpath,
} from "../src/renderers/cm6/CM6EditorFactory";
import {
  registerLanguageSupport,
  resolveLanguageExtension,
  unregisterLanguageSupport,
} from "../src/renderers/cm6/LanguageSupportMap";
import type {
  EditMode,
  FileEmbedEventPayload,
  FileOpenEventPayload,
  FileTypeConfig,
  RendererInstance,
  RendererMiddleware,
} from "../src/types/contracts";

describe("CM6EditorFactory, LanguageSupportMap, and TextCodeRendererMiddleware", () => {
  it("resolves language extensions for all built-in file types and supports custom language registration", () => {
    const registry = new FileTypeRegistry();
    for (const cfg of registry.getAll()) {
      const ext = resolveLanguageExtension(cfg.languageId, cfg.extension);
      expect(ext).toBeDefined();
    }

    const customFactory = vi.fn(() => []);
    registerLanguageSupport("my-dsl", customFactory);
    resolveLanguageExtension("my-dsl");
    expect(customFactory).toHaveBeenCalledTimes(1);

    expect(unregisterLanguageSupport("my-dsl")).toBe(true);
    expect(unregisterLanguageSupport("my-dsl")).toBe(false);
  });

  it("enforces read-only mode on CM6 EditorView and live-reconfigures the readOnly Compartment", () => {
    const containerEl = document.createElement("div");
    const onContentChange = vi.fn();

    const editor = CM6EditorFactory.createEditor({
      containerEl,
      initialData: "line 1\nline 2",
      mode: "readonly",
      languageId: "log",
      extension: "log",
      onContentChange,
    });

    expect(editor.getMode()).toBe("readonly");
    expect(editor.isReadOnly()).toBe(true);
    expect(editor.view.state.readOnly).toBe(true);
    expect(editor.view.contentDOM.getAttribute("contenteditable")).toBe("false");
    expect(editor.wrapperEl.classList.contains("is-readonly")).toBe(true);

    // 1. Attempt unannotated edit dispatch while in readonly mode -> blocked by transactionFilter
    editor.view.dispatch({
      changes: { from: 0, to: 0, insert: "UNAUTHORIZED " },
    });
    expect(editor.getValue()).toBe("line 1\nline 2");
    expect(onContentChange).not.toHaveBeenCalled();

    // 2. Programmatic setValue() succeeds in readonly mode without firing onContentChange
    editor.setValue("updated from disk");
    expect(editor.getValue()).toBe("updated from disk");
    expect(onContentChange).not.toHaveBeenCalled();

    // 3. Reconfigure compartment live to editable mode
    editor.setMode("editable");
    expect(editor.getMode()).toBe("editable");
    expect(editor.isReadOnly()).toBe(false);
    expect(editor.view.state.readOnly).toBe(false);
    expect(editor.view.contentDOM.getAttribute("contenteditable")).toBe("true");
    expect(editor.wrapperEl.classList.contains("is-editable")).toBe(true);

    // 4. User/external edit dispatch now succeeds and triggers onContentChange
    editor.view.dispatch({
      changes: { from: editor.getValue().length, insert: "\nappended line" },
    });
    expect(editor.getValue()).toBe("updated from disk\nappended line");
    expect(onContentChange).toHaveBeenCalledTimes(1);
    expect(onContentChange).toHaveBeenLastCalledWith(
      "updated from disk\nappended line"
    );

    // 5. Switch back to readonly mode and verify edits are blocked again
    editor.setMode("readonly");
    expect(editor.isReadOnly()).toBe(true);
    editor.view.dispatch({
      changes: { from: 0, to: 7, insert: "HACKED" },
    });
    expect(editor.getValue()).toBe("updated from disk\nappended line");
    expect(onContentChange).toHaveBeenCalledTimes(1);

    editor.destroy();
    expect(containerEl.children.length).toBe(0);
  });

  it("parses and slices line-range subpaths for inline embeds", () => {
    expect(parseLineRangeSubpath("#L3")).toEqual({ startLine: 3, endLine: 3 });
    expect(parseLineRangeSubpath("L2-L4")).toEqual({
      startLine: 2,
      endLine: 4,
    });
    expect(parseLineRangeSubpath("#L5-8")).toEqual({
      startLine: 5,
      endLine: 8,
    });
    expect(parseLineRangeSubpath("heading-name")).toBeNull();

    const content = ["alpha", "beta", "gamma", "delta", "epsilon"].join("\n");
    const sliced = applySubpathToContent(content, "#L2-L4");
    expect(sliced).toEqual({
      text: "beta\ngamma\ndelta",
      startLine: 2,
    });

    const containerEl = document.createElement("div");
    const embedEditor = CM6EditorFactory.createEditor({
      containerEl,
      initialData: content,
      mode: "editable",
      languageId: "c",
      extension: "c",
      isEmbed: true,
      subpath: "#L2-L4",
    });

    // Subpath embeds are always forced to readonly even if mode: 'editable' was requested
    expect(embedEditor.getMode()).toBe("readonly");
    expect(embedEditor.isReadOnly()).toBe(true);
    expect(embedEditor.getValue()).toBe("beta\ngamma\ndelta");
    embedEditor.setMode("editable");
    expect(embedEditor.getMode()).toBe("readonly");
    expect(embedEditor.isReadOnly()).toBe(true);
    embedEditor.destroy();
  });

  it("mounts views and embeds via TextCodeRendererMiddleware and tracks active instances cleanly", async () => {
    const bus = new EventBus();
    const registry = new FileTypeRegistry();
    const middleware = new TextCodeRendererMiddleware();
    middleware.register(bus);

    const app = createMockApp() as any;
    app.vault.read = vi.fn(async () => "int main() { return 0; }");
    app.vault.modify = vi.fn(async () => {});

    const cFile = createMockTFile("src/main.c") as any;
    const cConfig = registry.get("c")!;

    // 1. Emit file:open
    const viewContainer = createMockElement("div") as HTMLElement;
    const openPayload = await bus.emit("file:open", {
      app,
      file: cFile,
      config: cConfig,
      containerEl: viewContainer,
      mode: cConfig.tabMode,
      data: "int main() { return 0; }",
    });

    expect(openPayload.instance).toBeDefined();
    expect(openPayload.instance?.getMode()).toBe("editable");
    expect(openPayload.instance?.getValue()).toBe("int main() { return 0; }");
    expect(middleware.getActiveInstanceCount()).toBe(1);

    // 2. Emit file:embed
    const embedContainer = document.createElement("div");
    const embedPayload = await bus.emit("file:embed", {
      app,
      file: cFile,
      config: cConfig,
      containerEl: embedContainer,
      mode: cConfig.embedMode,
    });

    expect(embedPayload.instance).toBeDefined();
    expect(embedPayload.instance?.getMode()).toBe("readonly");
    expect(embedPayload.instance?.getValue()).toBe("int main() { return 0; }");
    expect(middleware.getActiveInstanceCount()).toBe(2);

    // Destroying one instance removes it from active tracking
    openPayload.instance?.destroy();
    expect(middleware.getActiveInstanceCount()).toBe(1);

    // Destroying the middleware cleans up remaining active instances
    middleware.destroy();
    expect(middleware.getActiveInstanceCount()).toBe(0);
  });

  it("allows future WASM or binary RendererMiddleware / RendererAdapter implementations to plug into the EventBus without core changes", async () => {
    const bus = new EventBus();
    const rendererRegistry = new RendererRegistry();
    const textMiddleware = new TextCodeRendererMiddleware(rendererRegistry);

    const wasmDestroySpy = vi.fn();
    let wasmMode: EditMode = "readonly";
    let wasmValue = "WASM_CANVAS_READY";

    const wasmMiddleware: RendererMiddleware = {
      id: "wasm-viewer",
      supports(config: FileTypeConfig): boolean {
        return config.rendererId === "wasm-viewer";
      },
      mountView(payload: FileOpenEventPayload): RendererInstance {
        wasmMode = payload.mode;
        return {
          getValue: () => wasmValue,
          setValue: (d: string) => {
            wasmValue = d;
          },
          setMode: (m: EditMode) => {
            wasmMode = m;
          },
          getMode: () => wasmMode,
          destroy: wasmDestroySpy,
        };
      },
      mountEmbed(payload: FileEmbedEventPayload): RendererInstance {
        wasmMode = payload.mode;
        return {
          getValue: () => `EMBED:${wasmValue}`,
          setValue: (d: string) => {
            wasmValue = d;
          },
          setMode: (m: EditMode) => {
            wasmMode = m;
          },
          getMode: () => wasmMode,
          destroy: wasmDestroySpy,
        };
      },
      destroy: wasmDestroySpy,
    };

    // Register custom WASM middleware alongside default text middleware
    registerRendererMiddleware(bus, wasmMiddleware);
    textMiddleware.register(bus);

    const app = createMockApp() as any;
    const binFile = createMockTFile("assets/model.bin") as any;
    const binConfig: FileTypeConfig = {
      extension: "bin",
      category: "binary",
      badgeLabel: "BIN",
      languageId: "wasm:model",
      rendererId: "wasm-viewer",
      tabMode: "readonly",
      embedMode: "readonly",
      enabled: true,
      isCustom: true,
    };

    const openResult = await bus.emit("file:open", {
      app,
      file: binFile,
      config: binConfig,
      containerEl: document.createElement("div"),
      mode: "readonly",
    });

    expect(openResult.instance?.getValue()).toBe("WASM_CANVAS_READY");
    expect(textMiddleware.getActiveInstanceCount()).toBe(0);

    const embedResult = await bus.emit("file:embed", {
      app,
      file: binFile,
      config: binConfig,
      containerEl: document.createElement("div"),
      mode: "readonly",
    });

    expect(embedResult.instance?.getValue()).toBe("EMBED:WASM_CANVAS_READY");
  });
});
