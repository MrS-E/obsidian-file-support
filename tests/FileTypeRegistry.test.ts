import { describe, expect, it } from "vitest";
import { createMockTFile } from "./__mocks__/obsidian";
import {
  DEFAULT_FILE_TYPE_PRESETS,
  FileTypeRegistry,
  RESERVED_OBSIDIAN_EXTENSIONS,
  isBuiltInExtension,
  normalizeExtension,
  resolveFileTypeConfig,
  validateExtension,
} from "../src/core/FileTypeRegistry";

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
      expect(isBuiltInExtension(ext)).toBe(true);
    }

    for (const ext of readonlyTabExtensions) {
      const cfg = registry.get(ext);
      expect(cfg).toBeDefined();
      expect(cfg?.enabled).toBe(true);
      expect(cfg?.tabMode).toBe("readonly");
      expect(cfg?.embedMode).toBe("readonly");
      expect(cfg?.badgeLabel).toBe(ext.toUpperCase());
      expect(cfg?.isCustom).toBe(false);
      expect(isBuiltInExtension(ext)).toBe(true);
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

  it("applies user overrides, supports custom extension registration/removal, and refuses unregistering built-ins", () => {
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

    // Refuses unregistering built-in extensions
    expect(registry.unregister("log")).toBe(false);
    expect(registry.isRegistered("log")).toBe(true);

    // Can reset built-in extension back to default preset
    const resetLog = registry.resetConfig("log");
    expect(resetLog?.tabMode).toBe("readonly");
    expect(resetLog?.badgeLabel).toBe("LOG");

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

  it("validates custom extensions against empty input, invalid characters, reserved Obsidian types, and duplicates", () => {
    const registry = new FileTypeRegistry();

    // Empty / dot-only inputs
    for (const emptyInput of ["", "   ", ".", "...", null as any, 123 as any]) {
      const res = validateExtension(emptyInput);
      expect(res.valid).toBe(false);
      expect(res.reason).toBe("empty");
      expect(() =>
        registry.register({ extension: emptyInput as string })
      ).toThrow();
    }

    // Invalid characters: whitespace, slashes, internal dots, special punctuation
    for (const badFormat of [
      "my ext",
      "a/b",
      "a\\b",
      "tar.gz",
      "file.name.ext",
      "c$",
      "@bad",
      "-leading-dash",
    ]) {
      const res = validateExtension(badFormat);
      expect(res.valid).toBe(false);
      expect(res.reason).toBe("invalid_format");
      expect(() => registry.register({ extension: badFormat })).toThrow(
        /Invalid file extension/
      );
    }

    // Reserved Obsidian core extensions (md, canvas, pdf, images, audio, video)
    for (const reserved of [
      "md",
      ".MD",
      "markdown",
      "canvas",
      "base",
      "pdf",
      "png",
      "jpg",
      "jpeg",
      "gif",
      "svg",
      "webp",
      "mp3",
      "wav",
      "ogg",
      "flac",
      "mp4",
      "webm",
      "mov",
      "mkv",
    ]) {
      const norm = normalizeExtension(reserved);
      expect(RESERVED_OBSIDIAN_EXTENSIONS.has(norm)).toBe(true);
      const res = validateExtension(reserved);
      expect(res.valid).toBe(false);
      expect(res.reason).toBe("reserved");
      expect(() => registry.register({ extension: reserved })).toThrow(
        /reserved by Obsidian/
      );
    }

    // Duplicate registration of existing built-in or custom extension
    expect(() =>
      registry.register({ extension: "log", badgeLabel: "CHANGED" })
    ).toThrow(/already registered/);
    expect(registry.get("log")?.badgeLabel).toBe("LOG");

    registry.register({ extension: "cmake", badgeLabel: "CMAKE" });
    expect(() =>
      registry.register({ extension: ".CMAKE", badgeLabel: "OTHER" })
    ).toThrow(/already registered/);
    expect(registry.get("cmake")?.badgeLabel).toBe("CMAKE");
  });

  it("whitelists fields in resolveFileTypeConfig and keeps built-in preset metadata upgradable", () => {
    // Attempt to override non-overridable built-in fields (languageId, rendererId, category, isCustom)
    // and inject unknown junk keys
    const resolvedBuiltIn = resolveFileTypeConfig("h", {
      extension: "h",
      badgeLabel: "header",
      tabMode: "readonly",
      embedMode: "editable",
      enabled: false,
      languageId: "stale-lang",
      syntaxLanguage: "stale-lang",
      rendererId: "stale-renderer",
      category: "custom",
      isCustom: true,
      junkKey: "should-be-stripped",
    } as any);

    expect(resolvedBuiltIn.badgeLabel).toBe("HEADER");
    expect(resolvedBuiltIn.tabMode).toBe("readonly");
    expect(resolvedBuiltIn.embedMode).toBe("editable");
    expect(resolvedBuiltIn.enabled).toBe(false);
    // Non-overridable preset fields always match current DEFAULT_FILE_TYPE_PRESETS.h
    expect(resolvedBuiltIn.languageId).toBe(DEFAULT_FILE_TYPE_PRESETS.h.languageId);
    expect(resolvedBuiltIn.syntaxLanguage).toBe(
      DEFAULT_FILE_TYPE_PRESETS.h.syntaxLanguage
    );
    expect(resolvedBuiltIn.rendererId).toBe(DEFAULT_FILE_TYPE_PRESETS.h.rendererId);
    expect(resolvedBuiltIn.category).toBe(DEFAULT_FILE_TYPE_PRESETS.h.category);
    expect(resolvedBuiltIn.isCustom).toBe(false);
    expect("junkKey" in resolvedBuiltIn).toBe(false);

    // Custom file type validates field types and strips unknown keys
    const resolvedCustom = resolveFileTypeConfig("proto", {
      extension: "proto",
      tabMode: "invalid-mode" as any,
      embedMode: 123 as any,
      category: "not-a-category" as any,
      rendererId: "" as any,
      extractorId: null as any,
      extraGarbage: { nested: true },
    } as any);

    expect(resolvedCustom.extension).toBe("proto");
    expect(resolvedCustom.isCustom).toBe(true);
    expect(resolvedCustom.tabMode).toBe("editable");
    expect(resolvedCustom.embedMode).toBe("readonly");
    expect(resolvedCustom.category).toBe("custom");
    expect(resolvedCustom.rendererId).toBe("cm6-text");
    expect(resolvedCustom.extractorId).toBe("passthrough");
    expect("extraGarbage" in resolvedCustom).toBe(false);
  });

  it("treats constructor as a custom extension instead of an inherited preset key", () => {
    const registry = new FileTypeRegistry();
    const config = registry.register({ extension: "constructor" });

    expect(config).toMatchObject({
      extension: "constructor",
      badgeLabel: "CONSTRUCTOR",
      category: "custom",
      tabMode: "editable",
      embedMode: "readonly",
      enabled: true,
      isCustom: true,
    });
    expect(registry.get("constructor")).toEqual(config);
    expect(registry.resetConfig("constructor")).toBeUndefined();
  });
});
