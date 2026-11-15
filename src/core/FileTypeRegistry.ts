import type {
  EditMode,
  FileCategory,
  FileTypeConfig,
} from "../types/contracts";

/**
 * Normalize a raw file extension string to lowercase without leading dots.
 */
export function normalizeExtension(ext: string): string {
  if (typeof ext !== "string") {
    return "";
  }
  return ext.trim().replace(/^\.+/, "").toLowerCase();
}

const VALID_EDIT_MODES: ReadonlySet<EditMode> = new Set([
  "editable",
  "readonly",
]);

const VALID_FILE_CATEGORIES: ReadonlySet<FileCategory> = new Set([
  "text",
  "code",
  "data",
  "log",
  "patch",
  "binary",
  "custom",
]);

/**
 * Extensions natively owned by Obsidian core (notes, canvas, base, PDF, images, audio, video)
 * that must not be claimed as custom extensions.
 */
export const RESERVED_OBSIDIAN_EXTENSIONS: ReadonlySet<string> = new Set([
  // Core Markdown, Canvas, Bases
  "md",
  "markdown",
  "canvas",
  "base",
  // Documents
  "pdf",
  // Images
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "svg",
  "webp",
  "avif",
  "ico",
  "tif",
  "tiff",
  // Audio
  "mp3",
  "wav",
  "m4a",
  "ogg",
  "3gp",
  "flac",
  "opus",
  "aac",
  // Video
  "mp4",
  "webm",
  "ogv",
  "mov",
  "mkv",
  "avi",
]);

const VALID_EXTENSION_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export type ExtensionValidationErrorReason =
  | "empty"
  | "invalid_format"
  | "reserved";

export interface ExtensionValidationResult {
  valid: boolean;
  extension: string;
  reason?: ExtensionValidationErrorReason;
  error?: string;
}

/**
 * Validate a raw file extension string against syntax rules and Obsidian reserved types.
 */
export function validateExtension(
  rawExtension: unknown
): ExtensionValidationResult {
  if (typeof rawExtension !== "string") {
    return {
      valid: false,
      extension: "",
      reason: "empty",
      error: "File extension cannot be empty.",
    };
  }

  const norm = normalizeExtension(rawExtension);
  if (!norm) {
    return {
      valid: false,
      extension: "",
      reason: "empty",
      error: "File extension cannot be empty.",
    };
  }

  if (!VALID_EXTENSION_PATTERN.test(norm)) {
    return {
      valid: false,
      extension: norm,
      reason: "invalid_format",
      error: `Invalid file extension "${norm}". Extensions may only contain letters, numbers, hyphens, and underscores (no spaces, slashes, or dots).`,
    };
  }

  if (RESERVED_OBSIDIAN_EXTENSIONS.has(norm)) {
    return {
      valid: false,
      extension: norm,
      reason: "reserved",
      error: `Extension ".${norm}" is reserved by Obsidian for native files.`,
    };
  }

  return {
    valid: true,
    extension: norm,
  };
}

export function isValidEditMode(value: unknown): value is EditMode {
  return typeof value === "string" && VALID_EDIT_MODES.has(value as EditMode);
}

export function isValidFileCategory(value: unknown): value is FileCategory {
  return (
    typeof value === "string" &&
    VALID_FILE_CATEGORIES.has(value as FileCategory)
  );
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
 * Check whether an extension corresponds to a built-in default preset.
 */
export function isBuiltInExtension(extension: string): boolean {
  const norm = normalizeExtension(extension);
  return Object.prototype.hasOwnProperty.call(DEFAULT_FILE_TYPE_PRESETS, norm);
}

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
 * Normalize, validate, and whitelist a partial FileTypeConfig against either its
 * built-in preset or sensible defaults for custom user-added extensions.
 *
 * For built-in presets, only user-overridable fields (`badgeLabel`, `tabMode`,
 * `embedMode`, `enabled`, `extractorId`) are merged from `partial`, ensuring preset
 * fields (`languageId`, `syntaxLanguage`, `rendererId`, `category`, `isCustom`) stay up to date.
 */
export function resolveFileTypeConfig(
  extension: string,
  partial?: Partial<FileTypeConfig> | Record<string, unknown>
): FileTypeConfig {
  const rawCandidate =
    extension ||
    (partial && typeof partial.extension === "string" ? partial.extension : "");
  const validation = validateExtension(rawCandidate);
  if (!validation.valid) {
    throw new Error(validation.error ?? "Invalid file extension.");
  }
  const norm = validation.extension;
  const p = (
    partial && typeof partial === "object" && !Array.isArray(partial)
      ? partial
      : {}
  ) as Partial<FileTypeConfig>;

  const preset = isBuiltInExtension(norm)
    ? DEFAULT_FILE_TYPE_PRESETS[norm]
    : undefined;
  if (preset) {
    const badgeLabel =
      typeof p.badgeLabel === "string" && p.badgeLabel.trim().length > 0
        ? p.badgeLabel.trim().toUpperCase()
        : preset.badgeLabel;
    const tabMode: EditMode = isValidEditMode(p.tabMode)
      ? p.tabMode
      : preset.tabMode;
    const embedMode: EditMode = isValidEditMode(p.embedMode)
      ? p.embedMode
      : preset.embedMode;
    const enabled =
      typeof p.enabled === "boolean" ? p.enabled : preset.enabled;
    const extractorId =
      typeof p.extractorId === "string" && p.extractorId.trim().length > 0
        ? p.extractorId.trim()
        : preset.extractorId;

    return {
      extension: preset.extension,
      category: preset.category,
      badgeLabel,
      languageId: preset.languageId,
      syntaxLanguage: preset.syntaxLanguage ?? preset.languageId,
      rendererId: preset.rendererId,
      tabMode,
      embedMode,
      enabled,
      extractorId,
      isCustom: false,
    };
  }

  const category: FileCategory = isValidFileCategory(p.category)
    ? p.category
    : "custom";
  const badgeLabel =
    typeof p.badgeLabel === "string" && p.badgeLabel.trim().length > 0
      ? p.badgeLabel.trim().toUpperCase()
      : norm.toUpperCase();
  const languageId =
    typeof p.languageId === "string" && p.languageId.trim().length > 0
      ? p.languageId.trim()
      : typeof p.syntaxLanguage === "string" &&
          p.syntaxLanguage.trim().length > 0
        ? p.syntaxLanguage.trim()
        : "plaintext";
  const syntaxLanguage =
    typeof p.syntaxLanguage === "string" && p.syntaxLanguage.trim().length > 0
      ? p.syntaxLanguage.trim()
      : languageId;
  const rendererId =
    typeof p.rendererId === "string" && p.rendererId.trim().length > 0
      ? p.rendererId.trim()
      : "cm6-text";
  const tabMode: EditMode = isValidEditMode(p.tabMode) ? p.tabMode : "editable";
  const embedMode: EditMode = isValidEditMode(p.embedMode)
    ? p.embedMode
    : "readonly";
  const enabled = typeof p.enabled === "boolean" ? p.enabled : true;
  const extractorId =
    typeof p.extractorId === "string" && p.extractorId.trim().length > 0
      ? p.extractorId.trim()
      : "passthrough";

  return {
    extension: norm,
    category,
    badgeLabel,
    languageId,
    syntaxLanguage,
    rendererId,
    tabMode,
    embedMode,
    enabled,
    extractorId,
    isCustom: true,
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
   * Silently ignores malformed or reserved extension entries in persisted data.
   */
  applySettings(
    settingsFileTypes: Record<string, Partial<FileTypeConfig>>
  ): void {
    this.resetToDefaults();
    if (
      !settingsFileTypes ||
      typeof settingsFileTypes !== "object" ||
      Array.isArray(settingsFileTypes)
    ) {
      return;
    }
    for (const [rawKey, partial] of Object.entries(settingsFileTypes)) {
      if (!partial || typeof partial !== "object" || Array.isArray(partial)) {
        continue;
      }
      const candidate =
        typeof partial.extension === "string" && partial.extension.trim()
          ? partial.extension
          : rawKey;
      const validation = validateExtension(candidate);
      if (!validation.valid) {
        continue;
      }
      this.configs.set(
        validation.extension,
        resolveFileTypeConfig(validation.extension, partial)
      );
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
   * Register a new custom extension.
   * Rejects empty, malformed, reserved Obsidian core extensions, or already-registered extensions.
   */
  register(
    config: Partial<FileTypeConfig> & { extension: string }
  ): FileTypeConfig {
    const validation = validateExtension(config?.extension);
    if (!validation.valid) {
      throw new Error(validation.error ?? "Invalid file extension.");
    }
    const ext = validation.extension;
    if (this.configs.has(ext)) {
      throw new Error(`Extension ".${ext}" is already registered.`);
    }
    const merged = resolveFileTypeConfig(ext, {
      ...config,
      extension: ext,
      isCustom: true,
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
   * Unregister a custom user-added extension.
   * Built-in presets cannot be unregistered (returns `false`).
   */
  unregister(extension: string): boolean {
    const ext = normalizeExtension(extension);
    const existing = this.configs.get(ext);
    if (!existing || !existing.isCustom || isBuiltInExtension(ext)) {
      return false;
    }
    return this.configs.delete(ext);
  }

  /**
   * Reset a built-in extension back to its default preset configuration.
   */
  resetConfig(extension: string): FileTypeConfig | undefined {
    const ext = normalizeExtension(extension);
    const preset = isBuiltInExtension(ext)
      ? DEFAULT_FILE_TYPE_PRESETS[ext]
      : undefined;
    if (!preset) {
      return undefined;
    }
    const restored: FileTypeConfig = { ...preset };
    this.configs.set(ext, restored);
    return { ...restored };
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
