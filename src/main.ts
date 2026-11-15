import { Notice, Plugin } from "obsidian";
import { EventBus } from "./core/EventBus";
import {
  FileTypeRegistry,
  normalizeExtension,
  validateExtension,
} from "./core/FileTypeRegistry";
import {
  FileEmbedWidget,
  type ObsidianEmbedCreator,
  type ObsidianEmbedRegistry,
  createLivePreviewEmbedExtension,
  processMarkdownEmbeds,
} from "./embeds/FileEmbedWidget";
import { TextCodeRendererMiddleware } from "./middlewares/TextCodeRendererMiddleware";
import { RendererRegistry } from "./renderers/RendererRegistry";
import {
  FileSupportPluginHost,
  FileSupportSettingTab,
} from "./settings/FileSupportSettingTab";
import {
  createDefaultSettings,
  mergePluginSettings,
  serializePluginSettings,
} from "./settings/PluginSettings";
import type { FileTypeConfig, PluginSettings } from "./types/contracts";
import {
  SupportedFileView,
  VIEW_TYPE_FILE_SUPPORT,
} from "./views/SupportedFileView";

function haveSameEnabledExtensions(
  prev: Record<string, FileTypeConfig>,
  next: Record<string, FileTypeConfig>
): boolean {
  const prevKeys = Object.keys(prev).filter((k) => prev[k]?.enabled);
  const nextKeys = Object.keys(next).filter((k) => next[k]?.enabled);
  if (prevKeys.length !== nextKeys.length) {
    return false;
  }
  const nextSet = new Set(nextKeys);
  return prevKeys.every((k) => nextSet.has(k));
}

function diffFileTypeConfigs(
  prev: Record<string, FileTypeConfig>,
  next: Record<string, FileTypeConfig>
): string[] {
  const changed: string[] = [];
  const allKeys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of allKeys) {
    const a = prev[key];
    const b = next[key];
    if (!a || !b) {
      changed.push(key);
      continue;
    }
    if (
      a.enabled !== b.enabled ||
      a.tabMode !== b.tabMode ||
      a.embedMode !== b.embedMode ||
      a.badgeLabel !== b.badgeLabel ||
      a.languageId !== b.languageId ||
      a.rendererId !== b.rendererId ||
      a.extractorId !== b.extractorId
    ) {
      changed.push(key);
    }
  }
  return changed;
}

export default class FileSupportPlugin
  extends Plugin
  implements FileSupportPluginHost
{
  settings: PluginSettings = createDefaultSettings();
  registry: FileTypeRegistry = new FileTypeRegistry();
  eventBus: EventBus = new EventBus();
  rendererRegistry: RendererRegistry = new RendererRegistry();
  textCodeRendererMiddleware: TextCodeRendererMiddleware =
    new TextCodeRendererMiddleware(this.rendererRegistry);

  private lastSavedSettings: PluginSettings = createDefaultSettings();
  private registeredViewExtensions: Set<string> = new Set();
  private registeredEmbedExtensions: Set<string> = new Set();
  private embedCreator: ObsidianEmbedCreator | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.textCodeRendererMiddleware.register(this.eventBus);

    this.registerView(
      VIEW_TYPE_FILE_SUPPORT,
      (leaf) => new SupportedFileView(leaf, this)
    );

    this.syncRegisteredExtensions();
    this.syncEmbedRegistryExtensions();

    this.registerMarkdownPostProcessor((el, ctx) => {
      return processMarkdownEmbeds(el, ctx, this);
    });

    if (typeof this.registerEditorExtension === "function") {
      this.registerEditorExtension(createLivePreviewEmbedExtension(this));
    }

    this.addSettingTab(new FileSupportSettingTab(this.app, this));
  }

  async onunload(): Promise<void> {
    this.unregisterAllEmbedRegistryExtensions();
    this.unregisterAllViewExtensions();
    this.textCodeRendererMiddleware.destroy();
    this.eventBus.clear();
  }

  isExtensionRegisteredInEmbedRegistry(extension: string): boolean {
    return this.registeredEmbedExtensions.has(normalizeExtension(extension));
  }

  async loadSettings(): Promise<void> {
    const rawData = await this.loadData();
    const merged = mergePluginSettings(rawData);
    this.registry.applySettings(merged.fileTypes);
    this.settings = {
      ...merged,
      fileTypes: this.registry.toRecord(),
    };
    this.lastSavedSettings = mergePluginSettings(this.settings);
  }

  async saveSettings(changedExtensions?: string[]): Promise<void> {
    const previousSettings = this.lastSavedSettings;
    this.settings.fileTypes = this.registry.toRecord();
    const serialized = serializePluginSettings(this.settings);
    const merged = mergePluginSettings(serialized);
    this.registry.applySettings(merged.fileTypes);
    this.settings = {
      ...merged,
      fileTypes: this.registry.toRecord(),
    };
    this.lastSavedSettings = mergePluginSettings(this.settings);

    const effectiveChangedExtensions =
      changedExtensions ??
      diffFileTypeConfigs(previousSettings.fileTypes, this.settings.fileTypes);

    if (
      !haveSameEnabledExtensions(
        previousSettings.fileTypes,
        this.settings.fileTypes
      )
    ) {
      this.syncRegisteredExtensions();
      this.syncEmbedRegistryExtensions();
    }

    await this.saveData(serialized);
    await this.eventBus.emit("config:updated", {
      settings: this.settings,
      changedExtensions: effectiveChangedExtensions,
      previousSettings,
    });
  }

  async updateFileTypeConfig(
    extension: string,
    patch: Partial<FileTypeConfig>
  ): Promise<FileTypeConfig> {
    const ext = normalizeExtension(extension);
    const updated = this.registry.updateConfig(ext, patch);
    this.settings.fileTypes[ext] = updated;
    await this.saveSettings([ext]);
    return this.registry.get(ext) ?? updated;
  }

  async addCustomFileType(
    extension: string,
    partial?: Partial<FileTypeConfig>
  ): Promise<FileTypeConfig> {
    const validation = validateExtension(extension);
    if (!validation.valid) {
      const msg = validation.error ?? "Invalid file extension.";
      new Notice(msg);
      throw new Error(msg);
    }
    const ext = validation.extension;
    if (this.registry.isRegistered(ext)) {
      const msg = `Extension ".${ext}" is already registered.`;
      new Notice(msg);
      throw new Error(msg);
    }
    const created = this.registry.register({
      ...partial,
      extension: ext,
    });
    this.settings.fileTypes[ext] = created;
    await this.saveSettings([ext]);
    return this.registry.get(ext) ?? created;
  }

  async removeCustomFileType(extension: string): Promise<boolean> {
    const ext = normalizeExtension(extension);
    const removed = this.registry.unregister(ext);
    if (removed) {
      delete this.settings.fileTypes[ext];
      await this.saveSettings([ext]);
    }
    return removed;
  }

  /**
   * Synchronize enabled file extensions with Obsidian's view registry (`registerExtensions`).
   * Wraps registration per extension in try/catch so extensions already claimed by
   * another plugin log a warning without aborting plugin load.
   */
  syncRegisteredExtensions(): void {
    const enabledSet = new Set(this.registry.getEnabledExtensions());
    const viewRegistry = (this.app as any)?.viewRegistry;

    // Unregister any extensions we previously registered that are now disabled or removed
    for (const ext of Array.from(this.registeredViewExtensions)) {
      if (!enabledSet.has(ext)) {
        try {
          if (typeof viewRegistry?.unregisterExtensions === "function") {
            viewRegistry.unregisterExtensions([ext]);
          }
        } catch {
          // Ignore unregister errors on internal viewRegistry
        }
        this.registeredViewExtensions.delete(ext);
      }
    }

    // Register newly enabled extensions
    for (const ext of enabledSet) {
      if (this.registeredViewExtensions.has(ext)) {
        continue;
      }
      try {
        this.registerExtensions([ext], VIEW_TYPE_FILE_SUPPORT);
        this.registeredViewExtensions.add(ext);
      } catch (err) {
        console.warn(
          `[obsidian-file-support] Could not register view extension ".${ext}" (may already be claimed by another plugin):`,
          err
        );
      }
    }
  }

  /**
   * Synchronize enabled file extensions with Obsidian's `app.embedRegistry` when available.
   * Guarded with runtime feature detection and per-extension try/catch.
   */
  syncEmbedRegistryExtensions(): void {
    const embedRegistry = (this.app as any)?.embedRegistry as
      | ObsidianEmbedRegistry
      | undefined;
    if (!embedRegistry || typeof embedRegistry !== "object") {
      return;
    }

    if (!this.embedCreator) {
      this.embedCreator = FileEmbedWidget.createEmbedRegistryFactory(this);
    }

    const enabledSet = new Set(this.registry.getEnabledExtensions());

    // Unregister extensions we previously registered that are now disabled or removed
    for (const ext of Array.from(this.registeredEmbedExtensions)) {
      if (!enabledSet.has(ext)) {
        this.unregisterSingleEmbedExtension(embedRegistry, ext);
        this.registeredEmbedExtensions.delete(ext);
      }
    }

    // Register enabled extensions not yet registered
    for (const ext of enabledSet) {
      if (this.registeredEmbedExtensions.has(ext)) {
        continue;
      }
      const existingOwner = embedRegistry.embedByExtension?.[ext];
      if (existingOwner && existingOwner !== this.embedCreator) {
        console.warn(
          `[obsidian-file-support] Skipping embedRegistry registration for ".${ext}" because another handler is already registered.`
        );
        continue;
      }
      try {
        if (typeof embedRegistry.registerExtensions === "function") {
          embedRegistry.registerExtensions([ext], this.embedCreator);
          this.registeredEmbedExtensions.add(ext);
        } else if (typeof embedRegistry.registerExtension === "function") {
          embedRegistry.registerExtension(ext, this.embedCreator);
          this.registeredEmbedExtensions.add(ext);
        }
      } catch (err) {
        console.warn(
          `[obsidian-file-support] Could not register embed extension ".${ext}" in embedRegistry:`,
          err
        );
      }
    }
  }

  private unregisterSingleEmbedExtension(
    embedRegistry: ObsidianEmbedRegistry,
    ext: string
  ): void {
    try {
      if (typeof embedRegistry.unregisterExtensions === "function") {
        embedRegistry.unregisterExtensions([ext]);
      } else if (typeof embedRegistry.unregisterExtension === "function") {
        embedRegistry.unregisterExtension(ext);
      } else if (
        embedRegistry.embedByExtension &&
        embedRegistry.embedByExtension[ext] === this.embedCreator
      ) {
        delete embedRegistry.embedByExtension[ext];
      }
    } catch {
      // Ignore cleanup errors on internal embedRegistry
    }
  }

  private unregisterAllEmbedRegistryExtensions(): void {
    const embedRegistry = (this.app as any)?.embedRegistry as
      | ObsidianEmbedRegistry
      | undefined;
    if (embedRegistry && typeof embedRegistry === "object") {
      for (const ext of Array.from(this.registeredEmbedExtensions)) {
        this.unregisterSingleEmbedExtension(embedRegistry, ext);
      }
    }
    this.registeredEmbedExtensions.clear();
  }

  private unregisterAllViewExtensions(): void {
    const viewRegistry = (this.app as any)?.viewRegistry;
    if (
      viewRegistry &&
      typeof viewRegistry.unregisterExtensions === "function" &&
      this.registeredViewExtensions.size > 0
    ) {
      try {
        viewRegistry.unregisterExtensions(
          Array.from(this.registeredViewExtensions)
        );
      } catch {
        // Ignore cleanup errors on internal viewRegistry
      }
    }
    this.registeredViewExtensions.clear();
  }
}
