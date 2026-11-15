import type {
  FileTypeConfig,
  RendererAdapter,
  RendererInstance,
  RendererMountContext,
} from "../types/contracts";
import { CM6EditorFactory } from "./cm6/CM6EditorFactory";

export const DEFAULT_TEXT_RENDERER_ID = "cm6-text";

/**
 * Default CodeMirror 6 text and source code renderer adapter.
 */
export class CM6TextRendererAdapter implements RendererAdapter {
  readonly id = DEFAULT_TEXT_RENDERER_ID;

  supports(config: FileTypeConfig): boolean {
    return (
      Boolean(config) &&
      (config.rendererId === this.id || !config.rendererId)
    );
  }

  mount(ctx: RendererMountContext): RendererInstance {
    return CM6EditorFactory.createEditor({
      containerEl: ctx.containerEl,
      initialData: ctx.initialData ?? "",
      mode: ctx.mode,
      languageId: ctx.config.languageId ?? ctx.config.syntaxLanguage,
      extension: ctx.config.extension,
      isEmbed: ctx.isEmbed,
      subpath: ctx.subpath,
      onContentChange: ctx.onContentChange,
    });
  }
}

/**
 * Registry of pluggable RendererAdapter implementations (CM6 text/code now,
 * future WASM or binary application viewers later).
 */
export class RendererRegistry {
  private adapters: Map<string, RendererAdapter> = new Map();

  constructor(registerDefaults: boolean = true) {
    if (registerDefaults) {
      this.register(new CM6TextRendererAdapter());
    }
  }

  register(adapter: RendererAdapter): void {
    if (!adapter || typeof adapter.id !== "string" || !adapter.id.trim()) {
      throw new Error("RendererAdapter must have a non-empty string id.");
    }
    this.adapters.set(adapter.id.trim(), adapter);
  }

  unregister(id: string): boolean {
    if (typeof id !== "string") {
      return false;
    }
    return this.adapters.delete(id.trim());
  }

  get(id: string): RendererAdapter | undefined {
    if (typeof id !== "string") {
      return undefined;
    }
    return this.adapters.get(id.trim());
  }

  resolveForConfig(config: FileTypeConfig): RendererAdapter | undefined {
    if (!config) {
      return undefined;
    }
    const direct = this.adapters.get(config.rendererId);
    if (direct && (!direct.supports || direct.supports(config))) {
      return direct;
    }
    for (const adapter of this.adapters.values()) {
      if (adapter.supports?.(config)) {
        return adapter;
      }
    }
    return undefined;
  }

  getAll(): RendererAdapter[] {
    return Array.from(this.adapters.values());
  }
}
