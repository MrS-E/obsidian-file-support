import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import type { EventBus } from "../core/EventBus";
import {
  FileTypeRegistry,
  normalizeExtension,
} from "../core/FileTypeRegistry";
import type {
  EditMode,
  FileTypeConfig,
  PluginSettings,
} from "../types/contracts";
import { validateDirectoryRegex } from "./PluginSettings";

export interface FileSupportPluginHost extends Plugin {
  settings: PluginSettings;
  registry: FileTypeRegistry;
  eventBus: EventBus;
  saveSettings(changedExtensions?: string[]): Promise<void>;
  updateFileTypeConfig(
    extension: string,
    patch: Partial<FileTypeConfig>
  ): Promise<FileTypeConfig>;
  addCustomFileType(
    extension: string,
    partial?: Partial<FileTypeConfig>
  ): Promise<FileTypeConfig>;
  removeCustomFileType(extension: string): Promise<boolean>;
}

/**
 * Obsidian SettingTab providing per-file-type controls (enablement, badge label,
 * tab mode, embed mode), custom extension registration, and companion .md metadata settings.
 */
export class FileSupportSettingTab extends PluginSettingTab {
  plugin: FileSupportPluginHost;
  private newExtensionInput: string = "";
  private newExtensionBadge: string = "";

  constructor(app: App, plugin: FileSupportPluginHost) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "File Support Settings" });

    this.renderMetadataSection(containerEl);
    this.renderCustomExtensionSection(containerEl);
    this.renderFileTypesSection(containerEl);
  }

  private renderMetadataSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Companion Metadata Notes").setHeading();

    new Setting(containerEl)
      .setName("Enable companion .md metadata files")
      .setDesc(
        "Pair supported files with a hidden companion .md note for YAML frontmatter, tags, and extracted text (disabled by default)."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableMetadataFiles)
          .onChange(async (value) => {
            this.plugin.settings.enableMetadataFiles = value;
            await this.plugin.saveSettings();
          })
      );

    const regexSetting = new Setting(containerEl)
      .setName("Companion metadata directory regex")
      .setDesc(
        "Regular expression matching vault folder paths where companion .md notes are active (e.g. '.*' for all folders, or '^logs|attachments')."
      );

    const errorEl = regexSetting.descEl.createDiv({
      cls: "file-support-settings-regex-message",
    });

    const updateRegexValidationUI = (pattern: string, inputEl?: HTMLElement) => {
      const validation = validateDirectoryRegex(pattern);
      if (!validation.valid) {
        inputEl?.classList.add("file-support-settings-regex-error");
        errorEl.textContent = `Invalid regular expression: ${validation.error}`;
      } else {
        inputEl?.classList.remove("file-support-settings-regex-error");
        errorEl.textContent = "";
      }
      return validation;
    };

    regexSetting.addText((text) => {
      text
        .setPlaceholder(".*")
        .setValue(this.plugin.settings.metadataDirRegex)
        .onChange(async (value) => {
          updateRegexValidationUI(value, text.inputEl);
          this.plugin.settings.metadataDirRegex = value;
          await this.plugin.saveSettings();
        });
      updateRegexValidationUI(
        this.plugin.settings.metadataDirRegex,
        text.inputEl
      );
    });

    new Setting(containerEl)
      .setName("Companion target frontmatter property")
      .setDesc(
        "YAML frontmatter key used in companion .md notes to link back to the target file."
      )
      .addText((text) =>
        text
          .setPlaceholder("file-support-target")
          .setValue(this.plugin.settings.metadataFrontmatterKey)
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (trimmed.length > 0) {
              this.plugin.settings.metadataFrontmatterKey = trimmed;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Auto-run extractor on companion note creation")
      .setDesc(
        "Automatically invoke the configured content extractor when creating a new companion .md note."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoRunExtractorOnCreate)
          .onChange(async (value) => {
            this.plugin.settings.autoRunExtractorOnCreate = value;
            await this.plugin.saveSettings();
          })
      );
  }

  private renderCustomExtensionSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Add Custom File Extension").setHeading();

    new Setting(containerEl)
      .setName("Register additional extension")
      .setDesc(
        "Add a custom text or source code file extension (e.g. 'conf', 'cmake', 'gradle') to be managed by File Support."
      )
      .addText((text) =>
        text
          .setPlaceholder("Extension (e.g. conf)")
          .setValue(this.newExtensionInput)
          .onChange((value) => {
            this.newExtensionInput = value;
          })
      )
      .addText((text) =>
        text
          .setPlaceholder("Badge label (optional)")
          .setValue(this.newExtensionBadge)
          .onChange((value) => {
            this.newExtensionBadge = value;
          })
      )
      .addButton((btn) =>
        btn
          .setButtonText("Add extension")
          .setCta()
          .onClick(async () => {
            const ext = normalizeExtension(this.newExtensionInput);
            if (!ext) return;
            const badge = this.newExtensionBadge.trim().toUpperCase() || ext.toUpperCase();
            await this.plugin.addCustomFileType(ext, {
              badgeLabel: badge,
            });
            this.newExtensionInput = "";
            this.newExtensionBadge = "";
            this.display();
          })
      );
  }

  private renderFileTypesSection(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Per-File-Type Configuration")
      .setDesc(
        "Configure enablement, File Explorer badge label, tab mode (editable vs. read-only), and inline ![[file]] embed mode for each file extension."
      )
      .setHeading();

    const configs = this.plugin.registry.getAll();

    for (const cfg of configs) {
      const setting = new Setting(containerEl)
        .setName(`.${cfg.extension}`)
        .setDesc(
          `Category: ${cfg.category} | Language: ${cfg.languageId} | Badge: ${cfg.badgeLabel}`
        );

      // Badge label input
      setting.addText((text) =>
        text
          .setPlaceholder(cfg.extension.toUpperCase())
          .setValue(cfg.badgeLabel)
          .onChange(async (value) => {
            const badgeLabel =
              value.trim().toUpperCase() || cfg.extension.toUpperCase();
            await this.plugin.updateFileTypeConfig(cfg.extension, {
              badgeLabel,
            });
          })
      );

      // Tab mode dropdown ('editable' | 'readonly')
      setting.addDropdown((dropdown) =>
        dropdown
          .addOption("editable", "Tab: Editable")
          .addOption("readonly", "Tab: Read-only")
          .setValue(cfg.tabMode)
          .onChange(async (value) => {
            const tabMode: EditMode =
              value === "readonly" ? "readonly" : "editable";
            await this.plugin.updateFileTypeConfig(cfg.extension, {
              tabMode,
            });
          })
      );

      // Embed mode dropdown ('readonly' | 'editable')
      setting.addDropdown((dropdown) =>
        dropdown
          .addOption("readonly", "Embed: Read-only")
          .addOption("editable", "Embed: Editable")
          .setValue(cfg.embedMode)
          .onChange(async (value) => {
            const embedMode: EditMode =
              value === "editable" ? "editable" : "readonly";
            await this.plugin.updateFileTypeConfig(cfg.extension, {
              embedMode,
            });
          })
      );

      // Enable/disable toggle
      setting.addToggle((toggle) =>
        toggle
          .setTooltip(`Enable .${cfg.extension} support`)
          .setValue(cfg.enabled)
          .onChange(async (value) => {
            await this.plugin.updateFileTypeConfig(cfg.extension, {
              enabled: value,
            });
          })
      );

      if (cfg.isCustom) {
        setting.addExtraButton((btn) =>
          btn
            .setIcon("trash")
            .setTooltip(`Remove custom .${cfg.extension} extension`)
            .onClick(async () => {
              await this.plugin.removeCustomFileType(cfg.extension);
              this.display();
            })
        );
      }
    }
  }
}
