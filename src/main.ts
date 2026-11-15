import { Notice, Plugin } from "obsidian";
import { EventBus } from "./core/EventBus";
import {
  FileTypeRegistry,
  normalizeExtension,
  validateExtension,
} from "./core/FileTypeRegistry";
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

export default class FileSupportPlugin
  extends Plugin
  implements FileSupportPluginHost
{
  settings: PluginSettings = createDefaultSettings();
  registry: FileTypeRegistry = new FileTypeRegistry();
  eventBus: EventBus = new EventBus();
  private lastSavedSettings: PluginSettings = createDefaultSettings();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new FileSupportSettingTab(this.app, this));
  }

  async onunload(): Promise<void> {
    this.eventBus.clear();
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
    await this.saveData(serialized);
    await this.eventBus.emit("config:updated", {
      settings: this.settings,
      changedExtensions,
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
}
