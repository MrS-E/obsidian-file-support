import type {
  EditMode,
  FileCategory,
  FileTypeConfig,
} from "../types/contracts";

/**
 * Normalize a raw file extension string to lowercase without leading dots.
 */
export function normalizeExtension(ext: string): string {
  return ext.trim().replace(/^\.+/, "").toLowerCase();
}

function createPreset(
  extension: string,
  category: FileCategory,
  badgeLabel: string,
  languageId: string,
  tabMode: EditMode,
  embedMode: EditMode = "readonly"
): FileTypeConfig {
  const norm = normalizeExtension(extension);
  return {
    extension: norm,
    category,
    badgeLabel,
    languageId,
    syntaxLanguage: languageId,
    rendererId: "cm6-text",
    tabMode,
    embedMode,
    enabled: true,
    extractorId: "passthrough",
    isCustom: false,
  };
}

/**
 * Built-in file type presets.
 * - Editable tabs by default for code, data, and txt files.
 * - Read-only tabs by default for log, patch, and diff files.
 * - Read-only inline embeds by default for all supported file types.
 */
export const DEFAULT_FILE_TYPE_PRESETS: Readonly<
  Record<string, Readonly<FileTypeConfig>>
> = Object.freeze({
  txt: Object.freeze(createPreset("txt", "text", "TXT", "plaintext", "editable")),
  json: Object.freeze(createPreset("json", "data", "JSON", "json", "editable")),
  js: Object.freeze(createPreset("js", "code", "JS", "javascript", "editable")),
  ts: Object.freeze(createPreset("ts", "code", "TS", "typescript", "editable")),
  c: Object.freeze(createPreset("c", "code", "C", "c", "editable")),
  h: Object.freeze(createPreset("h", "code", "H", "cpp", "editable")),
  cpp: Object.freeze(createPreset("cpp", "code", "CPP", "cpp", "editable")),
  rb: Object.freeze(createPreset("rb", "code", "RB", "ruby", "editable")),
  py: Object.freeze(createPreset("py", "code", "PY", "python", "editable")),
  sh: Object.freeze(createPreset("sh", "code", "SH", "shell", "editable")),
  yaml: Object.freeze(createPreset("yaml", "data", "YAML", "yaml", "editable")),
  yml: Object.freeze(createPreset("yml", "data", "YML", "yaml", "editable")),
  toml: Object.freeze(createPreset("toml", "data", "TOML", "toml", "editable")),
  xml: Object.freeze(createPreset("xml", "data", "XML", "xml", "editable")),
  ini: Object.freeze(createPreset("ini", "data", "INI", "properties", "editable")),
  cfg: Object.freeze(createPreset("cfg", "data", "CFG", "properties", "editable")),
  log: Object.freeze(createPreset("log", "log", "LOG", "log", "readonly")),
  patch: Object.freeze(createPreset("patch", "patch", "PATCH", "diff", "readonly")),
  diff: Object.freeze(createPreset("diff", "patch", "DIFF", "diff", "readonly")),
});

/**
 * Create a mutable deep clone of all default file type configurations.
 */
export function createDefaultFileTypeConfigs(): Record<string, FileTypeConfig> {
  const result: Record<string, FileTypeConfig> = {};
  for (const [ext, preset] of Object.entries(DEFAULT_FILE_TYPE_PRESETS)) {
    result[ext] = { ...preset };
  }
  return result;
}

/**
 * Normalize and complete a partial FileTypeConfig against either its built-in preset
 * or sensible defaults for custom user-added extensions.
 */
export function resolveFileTypeConfig(
  extension: string,
  partial?: Partial<FileTypeConfig>
): FileTypeConfig {
  const norm = normalizeExtension(extension || partial?.extension || "");
  if (!norm) {
    throw new Error("File extension cannot be empty");
  }

  const preset = DEFAULT_FILE_TYPE_PRESETS[norm];
  const base: FileTypeConfig = preset
    ? { ...preset }
    : {
        extension: norm,
        category: "custom",
        badgeLabel: norm.toUpperCase(),
        languageId: "plaintext",
        syntaxLanguage: "plaintext",
        rendererId: "cm6-text",
        tabMode: "editable",
        embedMode: "readonly",
        enabled: true,
        extractorId: "passthrough",
        isCustom: true,
      };

  const languageId =
    partial?.languageId ?? partial?.syntaxLanguage ?? base.languageId;
  const syntaxLanguage =
    partial?.syntaxLanguage ?? partial?.languageId ?? base.syntaxLanguage ?? languageId;
  const tabMode: EditMode =
    partial?.tabMode === "readonly" || partial?.tabMode === "editable"
      ? partial.tabMode
      : base.tabMode;
  const embedMode: EditMode =
    partial?.embedMode === "readonly" || partial?.embedMode === "editable"
      ? partial.embedMode
      : base.embedMode;
  const badgeLabel =
    typeof partial?.badgeLabel === "string" && partial.badgeLabel.trim().length > 0
      ? partial.badgeLabel.trim().toUpperCase()
      : base.badgeLabel;

  return {
    ...base,
    ...partial,
    extension: norm,
    badgeLabel,
    languageId,
    syntaxLanguage,
    tabMode,
    embedMode,
    enabled: typeof partial?.enabled === "boolean" ? partial.enabled : base.enabled,
    isCustom: preset ? false : (partial?.isCustom ?? true),
  };
}

/**
 * Registry managing built-in and user-configured file type descriptors.
 */
export class FileTypeRegistry {
  private configs: Map<string, FileTypeConfig> = new Map();

  constructor(initialConfigs?: Record<string, Partial<FileTypeConfig>>) {
    this.resetToDefaults();
    if (initialConfigs) {
      this.applySettings(initialConfigs);
    }
  }

  /**
   * Reset the registry to built-in default presets.
   */
  resetToDefaults(): void {
    this.configs.clear();
    const defaults = createDefaultFileTypeConfigs();
    for (const [ext, config] of Object.entries(defaults)) {
      this.configs.set(ext, config);
    }
  }

  /**
   * Apply user setting overrides and custom extensions on top of built-in defaults.
   */
  applySettings(settingsFileTypes: Record<string, Partial<FileTypeConfig>>): void {
    this.resetToDefaults();
    for (const [rawKey, partial] of Object.entries(settingsFileTypes ?? {})) {
      const ext = normalizeExtension(partial?.extension || rawKey);
      if (!ext) continue;
      this.configs.set(ext, resolveFileTypeConfig(ext, partial));
    }
  }

  /**
   * Get configuration for an extension (case-insensitive, with or without leading dot).
   */
  get(extension: string): FileTypeConfig | undefined {
    const norm = normalizeExtension(extension);
    const found = this.configs.get(norm);
    return found ? { ...found } : undefined;
  }

  /**
   * Alias for `get(extension)`.
   */
  getConfig(extension: string): FileTypeConfig | undefined {
    return this.get(extension);
  }

  /**
   * Look up configuration for a TFile-like object or file path string.
   */
  getForFile(
    fileOrPath: { extension?: string; path?: string; name?: string } | string
  ): FileTypeConfig | undefined {
    if (typeof fileOrPath === "string") {
      const lastSegment = fileOrPath.split("/").pop() ?? fileOrPath;
      const dotIdx = lastSegment.lastIndexOf(".");
      if (dotIdx <= 0) return undefined;
      return this.get(lastSegment.slice(dotIdx + 1));
    }
    if (fileOrPath.extension) {
      return this.get(fileOrPath.extension);
    }
    const nameOrPath = fileOrPath.name ?? fileOrPath.path ?? "";
    return this.getForFile(nameOrPath);
  }

  /**
   * Check whether an extension is registered in the registry (regardless of `enabled`).
   */
  isRegistered(extension: string): boolean {
    return this.configs.has(normalizeExtension(extension));
  }

  /**
   * Check whether an extension is registered AND enabled.
   */
  isSupported(extension: string): boolean {
    const cfg = this.configs.get(normalizeExtension(extension));
    return Boolean(cfg && cfg.enabled);
  }

  /**
   * Get effective tab edit mode for an extension ('readonly' if unknown).
   */
  getEffectiveTabMode(extension: string): EditMode {
    return this.configs.get(normalizeExtension(extension))?.tabMode ?? "readonly";
  }

  /**
   * Get effective inline embed edit mode for an extension ('readonly' if unknown).
   */
  getEffectiveEmbedMode(extension: string): EditMode {
    return this.configs.get(normalizeExtension(extension))?.embedMode ?? "readonly";
  }

  /**
   * Register a new custom extension or override an existing extension's configuration.
   */
  register(
    config: Partial<FileTypeConfig> & { extension: string }
  ): FileTypeConfig {
    const ext = normalizeExtension(config.extension);
    if (!ext) {
      throw new Error("File extension cannot be empty");
    }
    const existing = this.configs.get(ext);
    const merged = resolveFileTypeConfig(ext, {
      ...existing,
      ...config,
      extension: ext,
    });
    this.configs.set(ext, merged);
    return { ...merged };
  }

  /**
   * Update specific fields of a registered extension's configuration.
   */
  updateConfig(
    extension: string,
    patch: Partial<FileTypeConfig>
  ): FileTypeConfig {
    const ext = normalizeExtension(extension);
    const existing = this.configs.get(ext);
    if (!existing) {
      throw new Error(`Unknown file extension: "${ext}"`);
    }
    const updated = resolveFileTypeConfig(ext, {
      ...existing,
      ...patch,
      extension: ext,
    });
    this.configs.set(ext, updated);
    return { ...updated };
  }

  /**
   * Unregister a custom extension (or reset a built-in extension if requested).
   */
  unregister(extension: string): boolean {
    const ext = normalizeExtension(extension);
    return this.configs.delete(ext);
  }

  /**
   * Return all registered FileTypeConfig objects.
   */
  getAll(): FileTypeConfig[] {
    return Array.from(this.configs.values()).map((c) => ({ ...c }));
  }

  /**
   * Return all enabled FileTypeConfig objects.
   */
  getEnabled(): FileTypeConfig[] {
    return this.getAll().filter((c) => c.enabled);
  }

  /**
   * Return all enabled lowercase extension strings.
   */
  getEnabledExtensions(): string[] {
    return this.getEnabled().map((c) => c.extension);
  }

  /**
   * Export all configurations as a plain record suitable for persistence.
   */
  toRecord(): Record<string, FileTypeConfig> {
    const out: Record<string, FileTypeConfig> = {};
    for (const [ext, cfg] of this.configs.entries()) {
      out[ext] = { ...cfg };
    }
    return out;
  }
}
