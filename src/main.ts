import { Plugin } from "obsidian";
import { EventBus } from "./core/EventBus";
import { FileTypeRegistry, normalizeExtension } from "./core/FileTypeRegistry";
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

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new FileSupportSettingTab(this.app, this));
  }

  async onunload(): Promise<void> {
    this.eventBus.clear();
  }

  async loadSettings(): Promise<void> {
    const rawData = await this.loadData();
    this.settings = mergePluginSettings(rawData);
    this.registry.applySettings(this.settings.fileTypes);
    this.settings.fileTypes = this.registry.toRecord();
  }

  async saveSettings(changedExtensions?: string[]): Promise<void> {
    this.settings.fileTypes = this.registry.toRecord();
    const serialized = serializePluginSettings(this.settings);
    this.settings = serialized;
    await this.saveData(serialized);
    await this.eventBus.emit("config:updated", {
      settings: serialized,
      changedExtensions,
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
    return updated;
  }

  async addCustomFileType(
    extension: string,
    partial?: Partial<FileTypeConfig>
  ): Promise<FileTypeConfig> {
    const ext = normalizeExtension(extension);
    const created = this.registry.register({
      ...partial,
      extension: ext,
    });
    this.settings.fileTypes[ext] = created;
    await this.saveSettings([ext]);
    return created;
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
