import type { App, TFile } from "obsidian";
import type { EventBus, UnsubscribeFn } from "../core/EventBus";
import {
  DEFAULT_TEXT_RENDERER_ID,
  RendererRegistry,
} from "../renderers/RendererRegistry";
import type {
  ConfigUpdatedEventPayload,
  FileEmbedEventPayload,
  FileOpenEventPayload,
  FileTypeConfig,
  RendererInstance,
  RendererMiddleware,
} from "../types/contracts";

export type { RendererMiddleware } from "../types/contracts";

/**
 * Helper to wire any RendererMiddleware (text/code CM6, WASM viewer, binary inspector, etc.)
 * into the FileSupportEventBus pipeline for `file:open`, `file:embed`, and `config:updated`.
 */
export function registerRendererMiddleware(
  eventBus: EventBus,
  middleware: RendererMiddleware
): UnsubscribeFn {
  const unsubOpen = eventBus.use("file:open", async (payload, next) => {
    if (!payload.instance && middleware.supports(payload.config)) {
      payload.instance = await middleware.mountView(payload);
    }
    await next();
  });

  const unsubEmbed = eventBus.use("file:embed", async (payload, next) => {
    if (!payload.instance && middleware.supports(payload.config)) {
      payload.instance = await middleware.mountEmbed(payload);
    }
    await next();
  });

  const unsubConfig = middleware.onConfigChange
    ? eventBus.on("config:updated", async (payload) => {
        await middleware.onConfigChange?.(payload);
      })
    : undefined;

  return () => {
    unsubOpen();
    unsubEmbed();
    unsubConfig?.();
  };
}

async function readVaultFileContent(app: App, file: TFile): Promise<string> {
  const vault = app?.vault as any;
  if (!vault) {
    return "";
  }
  if (typeof vault.cachedRead === "function") {
    return await vault.cachedRead(file);
  }
  if (typeof vault.read === "function") {
    return await vault.read(file);
  }
  return "";
}

/**
 * Default renderer middleware handling text and source code files via CodeMirror 6
 * (and any additional adapters registered in RendererRegistry).
 */
export class TextCodeRendererMiddleware implements RendererMiddleware {
  readonly id: string = DEFAULT_TEXT_RENDERER_ID;
  private readonly rendererRegistry: RendererRegistry;
  private readonly activeInstances: Set<RendererInstance> = new Set();
  private unsubscribeBus: UnsubscribeFn | null = null;

  constructor(rendererRegistry?: RendererRegistry) {
    this.rendererRegistry = rendererRegistry ?? new RendererRegistry();
  }

  getRegistry(): RendererRegistry {
    return this.rendererRegistry;
  }

  supports(config: FileTypeConfig): boolean {
    if (!config || !config.enabled) {
      return false;
    }
    return Boolean(this.rendererRegistry.resolveForConfig(config));
  }

  register(eventBus: EventBus): UnsubscribeFn {
    this.unsubscribeBus?.();
    this.unsubscribeBus = registerRendererMiddleware(eventBus, this);
    return () => {
      this.unsubscribeBus?.();
      this.unsubscribeBus = null;
    };
  }

  mountView(
    payload: FileOpenEventPayload
  ): Promise<RendererInstance> | RendererInstance {
    const adapter = this.rendererRegistry.resolveForConfig(payload.config);
    if (!adapter) {
      throw new Error(
        `No RendererAdapter registered for rendererId "${payload.config.rendererId}".`
      );
    }

    if (typeof payload.data === "string") {
      const mounted = adapter.mount({
        app: payload.app,
        file: payload.file,
        config: payload.config,
        containerEl: payload.containerEl,
        mode: payload.mode,
        isEmbed: false,
        initialData: payload.data,
        onContentChange: payload.onContentChange,
        onOpenMetadata: payload.onOpenMetadata,
      });
      if (mounted instanceof Promise) {
        return mounted.then((inst) => this.trackInstance(inst, payload));
      }
      return this.trackInstance(mounted, payload);
    }

    return readVaultFileContent(payload.app, payload.file).then(
      async (initialData) => {
        const inst = await adapter.mount({
          app: payload.app,
          file: payload.file,
          config: payload.config,
          containerEl: payload.containerEl,
          mode: payload.mode,
          isEmbed: false,
          initialData,
          onContentChange: payload.onContentChange,
          onOpenMetadata: payload.onOpenMetadata,
        });
        return this.trackInstance(inst, payload);
      }
    );
  }

  mountEmbed(
    payload: FileEmbedEventPayload
  ): Promise<RendererInstance> | RendererInstance {
    const adapter = this.rendererRegistry.resolveForConfig(payload.config);
    if (!adapter) {
      throw new Error(
        `No RendererAdapter registered for rendererId "${payload.config.rendererId}".`
      );
    }

    const mountWithData = (
      initialData: string
    ): Promise<RendererInstance> | RendererInstance => {
      let currentInstance: RendererInstance | null = null;
      const onContentChange = (newData: string) => {
        if (
          currentInstance &&
          currentInstance.getMode() === "editable" &&
          !payload.subpath &&
          typeof payload.app?.vault?.modify === "function"
        ) {
          void payload.app.vault.modify(payload.file, newData);
        }
      };

      const mounted = adapter.mount({
        app: payload.app,
        file: payload.file,
        config: payload.config,
        containerEl: payload.containerEl,
        mode: payload.mode,
        isEmbed: true,
        initialData,
        subpath: payload.subpath,
        onContentChange,
        onOpenFile: payload.onOpenFile,
        onOpenMetadata: payload.onOpenMetadata,
      });

      if (mounted instanceof Promise) {
        return mounted.then((inst) => {
          currentInstance = inst;
          return this.trackInstance(inst, payload);
        });
      }
      currentInstance = mounted;
      return this.trackInstance(mounted, payload);
    };

    if (typeof payload.data === "string") {
      return mountWithData(payload.data);
    }

    return readVaultFileContent(payload.app, payload.file).then((initialData) =>
      mountWithData(initialData)
    );
  }

  onConfigChange(_payload: ConfigUpdatedEventPayload): void {
    // Individual open views and embeds subscribe to 'config:updated' to update
    // their effective mode (tabMode vs. embedMode) without unnecessary remounts.
  }

  destroy(): void {
    this.unsubscribeBus?.();
    this.unsubscribeBus = null;
    for (const instance of Array.from(this.activeInstances)) {
      try {
        instance.destroy();
      } catch {
        // Ignore cleanup errors on already-destroyed views
      }
    }
    this.activeInstances.clear();
  }

  getActiveInstanceCount(): number {
    return this.activeInstances.size;
  }

  private trackInstance(
    instance: RendererInstance,
    payload: { instance?: RendererInstance }
  ): RendererInstance {
    this.activeInstances.add(instance);
    const originalDestroy = instance.destroy.bind(instance);
    let cleaned = false;
    instance.destroy = () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      this.activeInstances.delete(instance);
      originalDestroy();
    };
    payload.instance = instance;
    return instance;
  }
}
