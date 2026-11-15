import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Notice,
  createMockApp,
  createMockManifest,
} from "./__mocks__/obsidian";
import { DEFAULT_FILE_TYPE_PRESETS } from "../src/core/FileTypeRegistry";
import FileSupportPlugin from "../src/main";
import { FileSupportSettingTab } from "../src/settings/FileSupportSettingTab";
import {
  DEFAULT_SETTINGS,
  mergePluginSettings,
  serializePluginSettings,
  validateDirectoryRegex,
} from "../src/settings/PluginSettings";

describe("PluginSettings serialization, merging, and validation", () => {
  beforeEach(() => {
    Notice.clear();
  });

  it("defaults enableMetadataFiles to false and serializes only user-overridable fields for built-ins", () => {
    expect(DEFAULT_SETTINGS.enableMetadataFiles).toBe(false);
    expect(DEFAULT_SETTINGS.metadataDirRegex).toBe(".*");
    expect(DEFAULT_SETTINGS.metadataFrontmatterKey).toBe("file-support-target");
    expect(DEFAULT_SETTINGS.metadataDefaultTags).toEqual(["file-metadata"]);
    expect(DEFAULT_SETTINGS.autoRunExtractorOnCreate).toBe(true);

    const merged = mergePluginSettings({
      enableMetadataFiles: true,
      metadataDirRegex: "^logs/",
      fileTypes: {
        log: {
          extension: "log",
          tabMode: "editable",
          embedMode: "editable",
          enabled: false,
          badgeLabel: "syslog",
          // Legacy snapshot fields that should not override built-in preset metadata
          category: "custom" as any,
          languageId: "old-log-lang",
          rendererId: "old-renderer",
        },
        ".conf": {
          extension: "conf",
          tabMode: "readonly",
          embedMode: "readonly",
          enabled: true,
          badgeLabel: "CONF",
          category: "data",
          languageId: "properties",
          rendererId: "cm6-text",
        },
      },
    });

    expect(merged.enableMetadataFiles).toBe(true);
    expect(merged.metadataDirRegex).toBe("^logs/");
    // Overridden built-in fields
    expect(merged.fileTypes.log.tabMode).toBe("editable");
    expect(merged.fileTypes.log.embedMode).toBe("editable");
    expect(merged.fileTypes.log.enabled).toBe(false);
    expect(merged.fileTypes.log.badgeLabel).toBe("SYSLOG");
    // Non-overridable built-in preset fields remain tied to DEFAULT_FILE_TYPE_PRESETS
    expect(merged.fileTypes.log.category).toBe("log");
    expect(merged.fileTypes.log.languageId).toBe("log");
    expect(merged.fileTypes.log.rendererId).toBe("cm6-text");
    expect(merged.fileTypes.log.isCustom).toBe(false);

    // Custom extension normalized and preserved
    expect(merged.fileTypes.conf).toBeDefined();
    expect(merged.fileTypes.conf.isCustom).toBe(true);
    expect(merged.fileTypes.conf.category).toBe("data");
    expect(merged.fileTypes.conf.languageId).toBe("properties");
    expect(merged.fileTypes.conf.tabMode).toBe("readonly");

    // Verify serializePluginSettings output structure
    const serialized = serializePluginSettings(merged);

    // Built-in entry in serialized payload contains ONLY overridable fields
    expect(serialized.fileTypes.log).toEqual({
      extension: "log",
      badgeLabel: "SYSLOG",
      tabMode: "editable",
      embedMode: "editable",
      enabled: false,
    });
    expect("languageId" in serialized.fileTypes.log).toBe(false);
    expect("syntaxLanguage" in serialized.fileTypes.log).toBe(false);
    expect("rendererId" in serialized.fileTypes.log).toBe(false);
    expect("category" in serialized.fileTypes.log).toBe(false);
    expect("isCustom" in serialized.fileTypes.log).toBe(false);

    // Custom entry in serialized payload preserves full FileTypeConfig
    expect(serialized.fileTypes.conf).toEqual({
      extension: "conf",
      category: "data",
      badgeLabel: "CONF",
      languageId: "properties",
      syntaxLanguage: "properties",
      rendererId: "cm6-text",
      tabMode: "readonly",
      embedMode: "readonly",
      enabled: true,
      extractorId: "passthrough",
      isCustom: true,
    });
  });

  it("gracefully handles malformed persisted data and falls back to defaults", () => {
    expect(mergePluginSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(mergePluginSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(mergePluginSettings("corrupt" as any)).toEqual(DEFAULT_SETTINGS);
    expect(mergePluginSettings([1, 2, 3] as any)).toEqual(DEFAULT_SETTINGS);

    const malformed = mergePluginSettings({
      fileTypes: "not-an-object" as any,
      enableMetadataFiles: "yes" as any,
      metadataDirRegex: 42 as any,
      metadataFrontmatterKey: "   ",
      metadataDefaultTags: [null, 123, "  ", " custom-tag ", {}] as any,
      autoRunExtractorOnCreate: "no" as any,
    });

    expect(malformed.enableMetadataFiles).toBe(false);
    expect(malformed.metadataDirRegex).toBe(".*");
    expect(malformed.metadataFrontmatterKey).toBe("file-support-target");
    expect(malformed.metadataDefaultTags).toEqual(["custom-tag"]);
    expect(malformed.autoRunExtractorOnCreate).toBe(true);
    expect(Object.keys(malformed.fileTypes)).toEqual(
      Object.keys(DEFAULT_FILE_TYPE_PRESETS)
    );

    const malformedEntries = mergePluginSettings({
      fileTypes: {
        log: {
          extension: "log",
          tabMode: "foo" as any,
          embedMode: "bar" as any,
          enabled: "nope" as any,
          badgeLabel: "   ",
          unknownProp: "junk",
        } as any,
        md: {
          extension: "md",
          tabMode: "editable",
        } as any,
        "tar.gz": {
          extension: "tar.gz",
          tabMode: "readonly",
        } as any,
        "a/b": {
          extension: "a/b",
        } as any,
        nullEntry: null as any,
        arrayEntry: [] as any,
      },
    });

    // Invalid values on 'log' fall back to preset defaults
    expect(malformedEntries.fileTypes.log.tabMode).toBe("readonly");
    expect(malformedEntries.fileTypes.log.embedMode).toBe("readonly");
    expect(malformedEntries.fileTypes.log.enabled).toBe(true);
    expect(malformedEntries.fileTypes.log.badgeLabel).toBe("LOG");
    expect("unknownProp" in malformedEntries.fileTypes.log).toBe(false);

    // Reserved or invalid extension keys are ignored
    expect(malformedEntries.fileTypes.md).toBeUndefined();
    expect(malformedEntries.fileTypes["tar.gz"]).toBeUndefined();
    expect(malformedEntries.fileTypes["a/b"]).toBeUndefined();
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

  it("completes a full saveData -> loadSettings persistence round trip across plugin instances without registry drift", async () => {
    const app = createMockApp() as any;
    const plugin1 = new FileSupportPlugin(app, createMockManifest());
    await plugin1.onload();

    const saveDataSpy = vi.spyOn(plugin1, "saveData");
    const configUpdatedSpy = vi.fn();
    plugin1.eventBus.on("config:updated", configUpdatedSpy);

    // 1. Update a built-in file type
    await plugin1.updateFileTypeConfig("log", {
      tabMode: "editable",
      embedMode: "editable",
      enabled: false,
      badgeLabel: "syslog",
    });

    expect(configUpdatedSpy).toHaveBeenCalledTimes(1);
    expect(configUpdatedSpy.mock.calls[0][0].changedExtensions).toEqual([
      "log",
    ]);
    expect(
      configUpdatedSpy.mock.calls[0][0].previousSettings.fileTypes.log.tabMode
    ).toBe("readonly");

    // 2. Add a custom extension
    await plugin1.addCustomFileType(".gradle", {
      badgeLabel: "grd",
      tabMode: "readonly",
      embedMode: "editable",
    });

    // Inspect the raw payload passed to saveData
    expect(saveDataSpy).toHaveBeenCalledTimes(2);
    const savedPayload = saveDataSpy.mock.calls[1][0];
    expect(savedPayload.fileTypes.log).toEqual({
      extension: "log",
      badgeLabel: "SYSLOG",
      tabMode: "editable",
      embedMode: "editable",
      enabled: false,
    });
    expect("languageId" in savedPayload.fileTypes.log).toBe(false);
    expect(savedPayload.fileTypes.gradle).toMatchObject({
      extension: "gradle",
      badgeLabel: "GRD",
      tabMode: "readonly",
      embedMode: "editable",
      enabled: true,
      isCustom: true,
    });

    // 3. Attempting to remove a built-in extension refuses and prevents registry/settings drift
    const removedBuiltIn = await plugin1.removeCustomFileType("log");
    expect(removedBuiltIn).toBe(false);
    expect(plugin1.registry.isRegistered("log")).toBe(true);
    expect(plugin1.settings.fileTypes.log).toBeDefined();

    // 4. Reload persisted data into a brand-new plugin instance
    const plugin2 = new FileSupportPlugin(app, createMockManifest());
    (plugin2 as any)._data = JSON.parse(JSON.stringify((plugin1 as any)._data));
    await plugin2.loadSettings();

    // Verify overrides on built-in 'log' survived reload
    expect(plugin2.registry.get("log")).toMatchObject({
      extension: "log",
      badgeLabel: "SYSLOG",
      tabMode: "editable",
      embedMode: "editable",
      enabled: false,
      isCustom: false,
    });
    expect(plugin2.settings.fileTypes.log.tabMode).toBe("editable");
    expect(plugin2.settings.fileTypes.log.badgeLabel).toBe("SYSLOG");

    // Verify custom extension 'gradle' survived reload
    expect(plugin2.registry.get("gradle")).toMatchObject({
      extension: "gradle",
      badgeLabel: "GRD",
      tabMode: "readonly",
      embedMode: "editable",
      enabled: true,
      isCustom: true,
    });

    // 5. Remove custom extension and verify removal persists across reload
    const removedCustom = await plugin2.removeCustomFileType("gradle");
    expect(removedCustom).toBe(true);
    expect(plugin2.registry.isRegistered("gradle")).toBe(false);
    expect(plugin2.settings.fileTypes.gradle).toBeUndefined();

    const plugin3 = new FileSupportPlugin(app, createMockManifest());
    (plugin3 as any)._data = JSON.parse(JSON.stringify((plugin2 as any)._data));
    await plugin3.loadSettings();
    expect(plugin3.registry.isRegistered("gradle")).toBe(false);
    expect(plugin3.settings.fileTypes.gradle).toBeUndefined();
  });

  it("exercises FileSupportSettingTab UI controls including Add extension button, validation Notices, badge input, and trash button", async () => {
    const app = createMockApp() as any;
    const plugin = new FileSupportPlugin(app, createMockManifest());
    await plugin.onload();

    const settingTab = new FileSupportSettingTab(app, plugin);
    settingTab.display();

    const getSettingsList = (): any[] =>
      (settingTab.containerEl as any)._settings ?? [];

    const findSetting = (name: string): any =>
      getSettingsList().find((s: any) => s.nameEl.textContent === name);

    // 1. Companion metadata section controls
    const enableMetaSetting = findSetting("Enable companion .md metadata files");
    expect(enableMetaSetting).toBeDefined();
    await enableMetaSetting.components[0].component.triggerChange(true);
    expect(plugin.settings.enableMetadataFiles).toBe(true);
    expect((plugin as any)._data.enableMetadataFiles).toBe(true);

    const regexSetting = findSetting("Companion metadata directory regex");
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
    expect((plugin as any)._data.metadataDirRegex).toBe("^logs/");

    // 2. Custom extension UI: test validation rejections and Notices
    let addExtSetting = findSetting("Register additional extension");
    expect(addExtSetting).toBeDefined();

    // Empty input -> Notice, no registration
    Notice.clear();
    addExtSetting.components[0].component.triggerChange("   ");
    await addExtSetting.components[2].component.triggerClick();
    expect(Notice.instances.length).toBe(1);
    expect(Notice.instances[0].message).toMatch(/cannot be empty/);

    // Invalid format ('tar.gz', 'my ext', 'a/b') -> Notice, no registration
    for (const invalidInput of ["tar.gz", "my ext", "a/b"]) {
      Notice.clear();
      addExtSetting = findSetting("Register additional extension");
      addExtSetting.components[0].component.triggerChange(invalidInput);
      await addExtSetting.components[2].component.triggerClick();
      expect(Notice.instances.length).toBe(1);
      expect(Notice.instances[0].message).toMatch(/Invalid file extension/);
    }

    // Reserved Obsidian extension ('md', 'canvas', 'pdf', 'png') -> Notice, no registration
    for (const reservedInput of ["md", "canvas", "pdf", "png"]) {
      Notice.clear();
      addExtSetting = findSetting("Register additional extension");
      addExtSetting.components[0].component.triggerChange(reservedInput);
      await addExtSetting.components[2].component.triggerClick();
      expect(Notice.instances.length).toBe(1);
      expect(Notice.instances[0].message).toMatch(/reserved by Obsidian/);
      expect(plugin.registry.isRegistered(reservedInput)).toBe(false);
    }

    // Existing built-in extension ('log') -> Notice, does NOT overwrite existing badge
    Notice.clear();
    addExtSetting = findSetting("Register additional extension");
    addExtSetting.components[0].component.triggerChange("log");
    addExtSetting.components[1].component.triggerChange("OVERWRITE");
    await addExtSetting.components[2].component.triggerClick();
    expect(Notice.instances.length).toBe(1);
    expect(Notice.instances[0].message).toMatch(/already registered/);
    expect(plugin.registry.get("log")?.badgeLabel).toBe("LOG");

    // 3. Valid custom extension via UI Add extension button
    Notice.clear();
    addExtSetting = findSetting("Register additional extension");
    addExtSetting.components[0].component.triggerChange(".cmake");
    addExtSetting.components[1].component.triggerChange("cmk");
    await addExtSetting.components[2].component.triggerClick();
    expect(Notice.instances.length).toBe(0);
    expect(plugin.registry.get("cmake")).toMatchObject({
      extension: "cmake",
      badgeLabel: "CMK",
      isCustom: true,
    });
    expect((plugin as any)._data.fileTypes.cmake).toMatchObject({
      extension: "cmake",
      badgeLabel: "CMK",
      isCustom: true,
    });

    // 4. Exercise per-file-type controls on .patch (including badge label text input)
    const patchSetting = findSetting(".patch");
    expect(patchSetting).toBeDefined();
    // [0] = badge text, [1] = tabMode dropdown, [2] = embedMode dropdown, [3] = enabled toggle
    await patchSetting.components[0].component.triggerChange("ptch");
    expect(plugin.registry.get("patch")?.badgeLabel).toBe("PTCH");
    expect((plugin as any)._data.fileTypes.patch.badgeLabel).toBe("PTCH");

    await patchSetting.components[1].component.triggerChange("editable");
    expect(plugin.registry.getEffectiveTabMode("patch")).toBe("editable");
    expect((plugin as any)._data.fileTypes.patch.tabMode).toBe("editable");

    await patchSetting.components[2].component.triggerChange("editable");
    expect(plugin.registry.getEffectiveEmbedMode("patch")).toBe("editable");
    expect((plugin as any)._data.fileTypes.patch.embedMode).toBe("editable");

    await patchSetting.components[3].component.triggerChange(false);
    expect(plugin.registry.isSupported("patch")).toBe(false);
    expect((plugin as any)._data.fileTypes.patch.enabled).toBe(false);

    // 5. Exercise trash extraButton on custom .cmake row
    const cmakeSetting = findSetting(".cmake");
    expect(cmakeSetting).toBeDefined();
    expect(cmakeSetting.components.length).toBe(5); // 4 standard + 1 extraButton (trash)
    await cmakeSetting.components[4].component.triggerClick();
    expect(plugin.registry.isRegistered("cmake")).toBe(false);
    expect((plugin as any)._data.fileTypes.cmake).toBeUndefined();
    expect(findSetting(".cmake")).toBeUndefined();
  });
});
