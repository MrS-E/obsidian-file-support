import { App, TFile, TextFileView, WorkspaceLeaf } from "obsidian";
import type { EventBus, UnsubscribeFn } from "../core/EventBus";
import {
  FileTypeRegistry,
  normalizeExtension,
  resolveFileTypeConfig,
} from "../core/FileTypeRegistry";
import type { LazyPairResolver } from "../metadata/LazyPairResolver";
import type {
  ConfigUpdatedEventPayload,
  EditMode,
  FileOpenEventPayload,
  FileTypeConfig,
  PluginSettings,
  RendererInstance,
} from "../types/contracts";

export const VIEW_TYPE_FILE_SUPPORT = "file-support-view";

export interface FileSupportViewHost {
  app: App;
  settings: PluginSettings;
  registry: FileTypeRegistry;
  eventBus: EventBus;
  pairResolver?: LazyPairResolver;
}

function clearElement(el: HTMLElement): void {
  if (typeof (el as any).empty === "function") {
    (el as any).empty();
    return;
  }
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
  el.textContent = "";
}

function createChildDiv(
  parent: HTMLElement,
  cls?: string,
  attr?: Record<string, string>
): HTMLElement {
  if (typeof (parent as any).createDiv === "function") {
    return (parent as any).createDiv({ cls, attr });
  }
  const doc = (parent as any).ownerDocument ?? document;
  const div = doc.createElement("div");
  if (cls) {
    cls
      .split(/\s+/)
      .filter(Boolean)
      .forEach((c) => div.classList.add(c));
  }
  if (attr) {
    for (const [k, v] of Object.entries(attr)) {
      div.setAttribute(k, v);
    }
  }
  parent.appendChild(div);
  return div;
}

/**
 * Dedicated Obsidian TextFileView for supported text, code, log, and patch files.
 * Delegates editor mounting to the EventBus (`file:open`) and reconfigures its
 * CodeMirror 6 readOnly compartment live when `config:updated` fires.
 */
export class SupportedFileView extends TextFileView {
  readonly plugin: FileSupportViewHost;
  private rendererInstance: RendererInstance | null = null;
  private editorHostEl: HTMLElement | null = null;
  private metadataActionEl: HTMLElement | null = null;
  private unsubscribeConfig: UnsubscribeFn | null = null;
  private currentMode: EditMode = "readonly";
  private mountedFilePath: string | null = null;
  private mountGeneration: number = 0;
  private isDirty: boolean = false;
  private lastSavedData: string = "";
  private initialized: boolean = false;

  constructor(leaf: WorkspaceLeaf, plugin: FileSupportViewHost) {
    super(leaf);
    this.plugin = plugin;
    if (plugin?.app) {
      this.app = plugin.app;
    }
  }

  getViewType(): string {
    return VIEW_TYPE_FILE_SUPPORT;
  }

  getDisplayText(): string {
    return this.file?.name ?? "Supported File";
  }

  getIcon(): string {
    if (!this.file) {
      return "file-text";
    }
    const cfg = this.plugin.registry.getForFile(this.file);
    if (
      cfg &&
      (cfg.category === "code" ||
        cfg.category === "data" ||
        cfg.category === "patch")
    ) {
      return "file-code";
    }
    return "file-text";
  }

  canAcceptExtension(extension: string): boolean {
    return this.plugin.registry.isSupported(extension);
  }

  onload(): void {
    super.onload?.();
    this.ensureInitialized();
  }

  onunload(): void {
    this.cleanupConfigSubscription();
    this.destroyRenderer();
    this.initialized = false;
    super.onunload?.();
  }

  async onLoadFile(file: TFile): Promise<void> {
    this.file = file;
    this.ensureInitialized();
    const content =
      typeof this.app?.vault?.read === "function"
        ? await this.app.vault.read(file)
        : (this.data ?? "");
    this.data = content;
    this.lastSavedData = content;
    this.isDirty = false;
    await this.mountEditor(file, content);
  }

  async onUnloadFile(file: TFile): Promise<void> {
    if (
      (this.isDirty || this.getViewData() !== this.lastSavedData) &&
      this.getMode() === "editable" &&
      this.file
    ) {
      await this.save(false);
    }
    this.destroyRenderer();
    this.mountedFilePath = null;
    if (typeof super.onUnloadFile === "function") {
      try {
        await super.onUnloadFile(file);
      } catch {
        // Ignore base class unload errors in mock environments
      }
    }
  }

  getViewData(): string {
    if (this.rendererInstance) {
      return this.rendererInstance.getValue();
    }
    return this.data ?? "";
  }

  setViewData(data: string, clear: boolean): void {
    this.data = data ?? "";
    if (clear || !this.isDirty) {
      this.lastSavedData = this.data;
    }
    this.ensureInitialized();
    if (!this.file) {
      return;
    }
    if (
      clear ||
      !this.rendererInstance ||
      this.mountedFilePath !== this.file.path
    ) {
      void this.mountEditor(this.file, this.data);
    } else if (this.rendererInstance.getValue() !== this.data) {
      this.rendererInstance.setValue(this.data);
    }
  }

  clear(): void {
    this.data = "";
    this.lastSavedData = "";
    this.isDirty = false;
    this.destroyRenderer();
    this.mountedFilePath = null;
  }

  async save(clear: boolean = false): Promise<void> {
    if (!this.file) {
      return;
    }
    // Enforce read-only mode: never write back to disk when view is read-only
    if (this.getMode() !== "editable") {
      if (clear) {
        this.clear();
      }
      return;
    }
    const currentData = this.getViewData();
    this.data = currentData;
    const hasChanges = this.isDirty || currentData !== this.lastSavedData;
    this.isDirty = false;
    if (hasChanges) {
      this.lastSavedData = currentData;
      if (typeof this.app?.vault?.modify === "function") {
        await this.app.vault.modify(this.file, currentData);
      }
    }
    if (clear) {
      this.clear();
    }
  }

  getMode(): EditMode {
    return this.rendererInstance?.getMode() ?? this.currentMode;
  }

  getRendererInstance(): RendererInstance | null {
    return this.rendererInstance;
  }

  getMetadataActionElement(): HTMLElement | null {
    return this.metadataActionEl;
  }

  /**
   * Dispatch `metadata:open-or-create` for the currently active target file.
   */
  async openCompanionMetadata(targetFile?: TFile | null): Promise<void> {
    const file = targetFile ?? this.file;
    if (!file) {
      return;
    }
    try {
      await this.plugin.eventBus.emit("metadata:open-or-create", {
        app: this.app,
        targetFile: file,
        openInNewLeaf: false,
      });
    } catch (err) {
      console.warn(
        `[FileSupport] Failed to open or create companion metadata for "${file.path}":`,
        err
      );
    }
  }

  private ensureInitialized(): void {
    if (this.contentEl?.classList) {
      this.contentEl.classList.add("file-support-view-content");
    }

    if (!this.metadataActionEl && typeof this.addAction === "function") {
      this.metadataActionEl = this.addAction(
        "file-symlink",
        "Open or create companion metadata note",
        () => {
          void this.openCompanionMetadata();
        }
      );
      if (this.metadataActionEl) {
        this.metadataActionEl.setAttribute?.(
          "data-file-support-action",
          "open-metadata"
        );
        this.metadataActionEl.classList?.add("file-support-metadata-action");
      }
    }

    this.updateMetadataActionVisibility();

    if (!this.unsubscribeConfig) {
      this.unsubscribeConfig = this.plugin.eventBus.on(
        "config:updated",
        (payload) => this.handleConfigUpdated(payload)
      );
      if (typeof (this as any).register === "function") {
        (this as any).register(() => this.cleanupConfigSubscription());
      }
    }

    this.initialized = true;
  }

  private updateMetadataActionVisibility(): void {
    if (!this.metadataActionEl) {
      return;
    }
    const enabled =
      Boolean(this.plugin.settings?.enableMetadataFiles) &&
      (!this.file ||
        !this.plugin.pairResolver ||
        this.plugin.pairResolver.isTargetEligible(this.file));
    this.metadataActionEl.classList?.toggle("is-disabled", !enabled);
    this.metadataActionEl.setAttribute?.(
      "aria-disabled",
      enabled ? "false" : "true"
    );
  }

  private resolveConfigForFile(file: TFile): FileTypeConfig {
    const fromRegistry = this.plugin.registry.getForFile(file);
    if (fromRegistry) {
      return fromRegistry;
    }
    return resolveFileTypeConfig(file.extension || "txt", {
      tabMode: "readonly",
      embedMode: "readonly",
    });
  }

  private async mountEditor(file: TFile, data: string): Promise<void> {
    const generation = ++this.mountGeneration;
    this.destroyRenderer();

    const config = this.resolveConfigForFile(file);
    const effectiveMode: EditMode = config.enabled
      ? config.tabMode
      : "readonly";
    this.currentMode = effectiveMode;
    this.mountedFilePath = file.path;

    if (this.contentEl) {
      clearElement(this.contentEl);
      this.contentEl.setAttribute?.("data-edit-mode", effectiveMode);
      this.contentEl.setAttribute?.("data-extension", config.extension);
      this.editorHostEl = createChildDiv(
        this.contentEl,
        "file-support-view-editor-host",
        {
          "data-extension": config.extension,
          "data-edit-mode": effectiveMode,
        }
      );
    }

    const hostEl =
      this.editorHostEl ??
      this.contentEl ??
      (document.createElement("div") as HTMLElement);

    const payload: FileOpenEventPayload = {
      app: this.app,
      file,
      config,
      containerEl: hostEl,
      mode: effectiveMode,
      data,
      onContentChange: (newData: string) => {
        this.handleContentChanged(newData);
      },
      onOpenMetadata: (target: TFile) => {
        void this.openCompanionMetadata(target);
      },
    };

    const emitPromise = this.plugin.eventBus.emit("file:open", payload);

    // Attach synchronously if a synchronous middleware (e.g. CM6) already populated payload.instance
    if (payload.instance && generation === this.mountGeneration) {
      this.rendererInstance = payload.instance;
    }

    const resolved = await emitPromise;
    if (generation !== this.mountGeneration) {
      // A newer mount superseded this one while awaiting an async middleware
      if (resolved.instance && resolved.instance !== this.rendererInstance) {
        resolved.instance.destroy();
      }
      return;
    }

    if (resolved.instance) {
      this.rendererInstance = resolved.instance;
      // Ensure mode stays aligned if config changed while mounting
      if (this.rendererInstance.getMode() !== this.currentMode) {
        this.rendererInstance.setMode(this.currentMode);
      }
    }
  }

  private handleContentChanged(newData: string): void {
    if (this.getMode() !== "editable") {
      return;
    }
    this.data = newData;
    this.isDirty = newData !== this.lastSavedData;
    if (this.isDirty) {
      this.requestSave();
    }
  }

  private async handleConfigUpdated(
    payload: ConfigUpdatedEventPayload
  ): Promise<void> {
    this.updateMetadataActionVisibility();

    if (!this.file) {
      return;
    }

    const fileExt = normalizeExtension(this.file.extension);
    if (Array.isArray(payload.changedExtensions)) {
      const affectsCurrentFile = payload.changedExtensions.some(
        (ext) => normalizeExtension(ext) === fileExt
      );
      if (!affectsCurrentFile) {
        return;
      }
    }

    const updatedConfig = this.plugin.registry.get(fileExt);
    const nextMode: EditMode =
      updatedConfig && updatedConfig.enabled
        ? updatedConfig.tabMode
        : "readonly";

    if (
      this.currentMode === nextMode &&
      this.rendererInstance?.getMode() === nextMode
    ) {
      return;
    }

    // Flush any pending dirty edits while still editable before switching to readonly
    let flushPromise: Promise<void> | null = null;
    if (
      this.getMode() === "editable" &&
      nextMode !== "editable" &&
      (this.isDirty || this.getViewData() !== this.lastSavedData)
    ) {
      flushPromise = this.save(false);
    }

    this.currentMode = nextMode;
    this.contentEl?.setAttribute?.("data-edit-mode", nextMode);
    this.editorHostEl?.setAttribute?.("data-edit-mode", nextMode);
    this.rendererInstance?.setMode(nextMode);

    if (flushPromise) {
      await flushPromise;
    }
  }

  private destroyRenderer(): void {
    if (this.rendererInstance) {
      const inst = this.rendererInstance;
      this.rendererInstance = null;
      inst.destroy();
    }
    if (this.editorHostEl) {
      clearElement(this.editorHostEl);
      this.editorHostEl = null;
    }
  }

  private cleanupConfigSubscription(): void {
    if (this.unsubscribeConfig) {
      this.unsubscribeConfig();
      this.unsubscribeConfig = null;
    }
  }
}
