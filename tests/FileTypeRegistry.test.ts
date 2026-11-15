import { describe, expect, it, vi } from "vitest";
import {
  createMockApp,
  createMockManifest,
  createMockTFile,
} from "./__mocks__/obsidian";
import {
  DEFAULT_FILE_TYPE_PRESETS,
  FileTypeRegistry,
  normalizeExtension,
} from "../src/core/FileTypeRegistry";
import FileSupportPlugin from "../src/main";
import { FileSupportSettingTab } from "../src/settings/FileSupportSettingTab";
import {
  DEFAULT_SETTINGS,
  createDefaultSettings,
  mergePluginSettings,
  serializePluginSettings,
  validateDirectoryRegex,
} from "../src/settings/PluginSettings";

describe("FileTypeRegistry", () => {
  it("provides default presets with editable tabs for code/txt and read-only tabs for log/patch/diff", () => {
    const registry = new FileTypeRegistry();

    const editableTabExtensions = [
      "txt",
      "json",
      "js",
      "ts",
      "c",
      "h",
      "cpp",
      "rb",
      "py",
      "sh",
      "yaml",
      "yml",
      "toml",
      "xml",
      "ini",
      "cfg",
    ];
    const readonlyTabExtensions = ["log", "patch", "diff"];

    for (const ext of editableTabExtensions) {
      const cfg = registry.get(ext);
      expect(cfg).toBeDefined();
      expect(cfg?.enabled).toBe(true);
      expect(cfg?.tabMode).toBe("editable");
      expect(cfg?.embedMode).toBe("readonly");
      expect(cfg?.badgeLabel).toBe(ext.toUpperCase());
      expect(cfg?.isCustom).toBe(false);
    }

    for (const ext of readonlyTabExtensions) {
      const cfg = registry.get(ext);
      expect(cfg).toBeDefined();
      expect(cfg?.enabled).toBe(true);
      expect(cfg?.tabMode).toBe("readonly");
      expect(cfg?.embedMode).toBe("readonly");
      expect(cfg?.badgeLabel).toBe(ext.toUpperCase());
      expect(cfg?.isCustom).toBe(false);
    }
  });

  it("normalizes extensions and resolves files by TFile or path", () => {
    const registry = new FileTypeRegistry();

    expect(normalizeExtension(".LOG")).toBe("log");
    expect(normalizeExtension("  ..Rb ")).toBe("rb");

    expect(registry.get(".PATCH")?.tabMode).toBe("readonly");
    expect(registry.getForFile(createMockTFile("src/main.c"))?.languageId).toBe(
      "c"
    );
    expect(registry.getForFile("scripts/deploy.rb")?.languageId).toBe("ruby");
    expect(registry.getForFile("README_NO_EXT")).toBeUndefined();
  });

  it("applies user overrides and supports custom extension registration and removal", () => {
    const registry = new FileTypeRegistry();

    registry.updateConfig("log", {
      tabMode: "editable",
      embedMode: "editable",
      badgeLabel: "syslog",
    });

    const updatedLog = registry.get("log");
    expect(updatedLog?.tabMode).toBe("editable");
    expect(updatedLog?.embedMode).toBe("editable");
    expect(updatedLog?.badgeLabel).toBe("SYSLOG");
    expect(registry.getEffectiveTabMode("log")).toBe("editable");
    expect(registry.getEffectiveEmbedMode("log")).toBe("editable");

    // Register a custom extension
    const custom = registry.register({
      extension: ".gradle",
      badgeLabel: "gradle",
      tabMode: "readonly",
    });
    expect(custom.extension).toBe("gradle");
    expect(custom.badgeLabel).toBe("GRADLE");
    expect(custom.tabMode).toBe("readonly");
    expect(custom.embedMode).toBe("readonly");
    expect(custom.isCustom).toBe(true);
    expect(registry.isSupported("gradle")).toBe(true);

    // Disable extension
    registry.updateConfig("gradle", { enabled: false });
    expect(registry.isRegistered("gradle")).toBe(true);
    expect(registry.isSupported("gradle")).toBe(false);

    // Unregister custom extension
    expect(registry.unregister("gradle")).toBe(true);
    expect(registry.isRegistered("gradle")).toBe(false);
  });
});

describe("PluginSettings & FileSupportSettingTab", () => {
  it("defaults enableMetadataFiles to false and merges partial persisted settings cleanly", () => {
    expect(DEFAULT_SETTINGS.enableMetadataFiles).toBe(false);
    expect(DEFAULT_SETTINGS.metadataDirRegex).toBe(".*");
    expect(DEFAULT_SETTINGS.metadataFrontmatterKey).toBe("file-support-target");

    const merged = mergePluginSettings({
      enableMetadataFiles: true,
      metadataDirRegex: "^logs/",
      fileTypes: {
        log: {
          extension: "log",
          tabMode: "editable",
          embedMode: "readonly",
          enabled: true,
          badgeLabel: "LOG",
          category: "log",
          languageId: "log",
          rendererId: "cm6-text",
        },
        ".conf": {
          extension: "conf",
          tabMode: "readonly",
          embedMode: "readonly",
          enabled: true,
          badgeLabel: "CONF",
          category: "custom",
          languageId: "properties",
          rendererId: "cm6-text",
        },
      },
    });

    expect(merged.enableMetadataFiles).toBe(true);
    expect(merged.metadataDirRegex).toBe("^logs/");
    // Overridden built-in preset
    expect(merged.fileTypes.log.tabMode).toBe("editable");
    // Unmentioned built-in preset preserved
    expect(merged.fileTypes.c.tabMode).toBe("editable");
    expect(merged.fileTypes.patch.tabMode).toBe("readonly");
    // Custom extension normalized and preserved
    expect(merged.fileTypes.conf).toBeDefined();
    expect(merged.fileTypes.conf.isCustom).toBe(true);
    expect(merged.fileTypes.conf.tabMode).toBe("readonly");

    const serialized = serializePluginSettings(merged);
    expect(JSON.parse(JSON.stringify(serialized))).toEqual(serialized);
  });

  it("validates directory regex patterns without throwing on malformed input", () => {
    const valid = validateDirectoryRegex("^notes/(logs|patches)$");
    expect(valid.valid).toBe(true);
    expect(valid.regex?.test("notes/logs")).toBe(true);

    const invalid = validateDirectoryRegex("[unclosed-group");
    expect(invalid.valid).toBe(false);
    expect(invalid.regex).toBeNull();
    expect(invalid.error).toBeDefined();
  });

  it("persists setting updates and emits config:updated via FileSupportPlugin and FileSupportSettingTab", async () => {
    const app = createMockApp() as any;
    const plugin = new FileSupportPlugin(app, createMockManifest());
    await plugin.onload();

    const configUpdatedSpy = vi.fn();
    plugin.eventBus.on("config:updated", configUpdatedSpy);

    await plugin.updateFileTypeConfig("log", { tabMode: "editable" });
    expect(plugin.registry.getEffectiveTabMode("log")).toBe("editable");
    expect(configUpdatedSpy).toHaveBeenCalledTimes(1);
    expect(configUpdatedSpy.mock.calls[0][0].changedExtensions).toEqual(["log"]);

    await plugin.addCustomFileType(".cmake", { badgeLabel: "CMAKE" });
    expect(plugin.registry.isSupported("cmake")).toBe(true);

    // Render setting tab and verify controls
    const settingTab = new FileSupportSettingTab(app, plugin);
    settingTab.display();
    const settingsList = (settingTab.containerEl as any)._settings ?? [];
    expect(settingsList.length).toBeGreaterThan(
      Object.keys(DEFAULT_FILE_TYPE_PRESETS).length
    );

    // Exercise companion metadata toggle and directory regex validation UI
    const enableMetaSetting = settingsList.find(
      (s: any) => s.nameEl.textContent === "Enable companion .md metadata files"
    );
    expect(enableMetaSetting).toBeDefined();
    await enableMetaSetting.components[0].component.triggerChange(true);
    expect(plugin.settings.enableMetadataFiles).toBe(true);

    const regexSetting = settingsList.find(
      (s: any) => s.nameEl.textContent === "Companion metadata directory regex"
    );
    expect(regexSetting).toBeDefined();
    const regexTextComp = regexSetting.components[0].component;
    await regexTextComp.triggerChange("[invalid");
    expect(
      regexTextComp.inputEl.classList.contains(
        "file-support-settings-regex-error"
      )
    ).toBe(true);
    await regexTextComp.triggerChange("^logs/");
    expect(
      regexTextComp.inputEl.classList.contains(
        "file-support-settings-regex-error"
      )
    ).toBe(false);
    expect(plugin.settings.metadataDirRegex).toBe("^logs/");

    // Exercise per-file-type controls for .patch
    const patchSetting = settingsList.find(
      (s: any) => s.nameEl.textContent === ".patch"
    );
    expect(patchSetting).toBeDefined();
    // [0] = badge text, [1] = tabMode dropdown, [2] = embedMode dropdown, [3] = enabled toggle
    await patchSetting.components[1].component.triggerChange("editable");
    expect(plugin.registry.getEffectiveTabMode("patch")).toBe("editable");
    await patchSetting.components[2].component.triggerChange("editable");
    expect(plugin.registry.getEffectiveEmbedMode("patch")).toBe("editable");
    await patchSetting.components[3].component.triggerChange(false);
    expect(plugin.registry.isSupported("patch")).toBe(false);

    await plugin.removeCustomFileType("cmake");
    expect(plugin.registry.isRegistered("cmake")).toBe(false);
  });
});
