import {
  DEFAULT_FILE_TYPE_PRESETS,
  createDefaultFileTypeConfigs,
  isBuiltInExtension,
  resolveFileTypeConfig,
  validateExtension,
} from "../core/FileTypeRegistry";
import type {
  BuiltInFileTypeOverride,
  FileTypeConfig,
  PersistedPluginSettings,
  PluginSettings,
} from "../types/contracts";

export interface RegexValidationResult {
  valid: boolean;
  regex: RegExp | null;
  error?: string;
}

/**
 * Validate a user-supplied directory regular expression pattern safely.
 */
export function validateDirectoryRegex(pattern: string): RegexValidationResult {
  try {
    const regex = new RegExp(pattern);
    return { valid: true, regex };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      regex: null,
      error: message,
    };
  }
}

/**
 * Create a fresh deep copy of default plugin settings.
 */
export function createDefaultSettings(): PluginSettings {
  return {
    fileTypes: createDefaultFileTypeConfigs(),
    enableMetadataFiles: false,
    metadataDirRegex: ".*",
    metadataFrontmatterKey: "file-support-target",
    metadataDefaultTags: ["file-metadata"],
    autoRunExtractorOnCreate: true,
  };
}

/**
 * Canonical default settings snapshot.
 */
export const DEFAULT_SETTINGS: Readonly<PluginSettings> = Object.freeze(
  createDefaultSettings()
);

/**
 * Merge partial or persisted settings data with built-in defaults.
 * Preserves user overrides on built-in extensions as well as custom user-added extensions,
 * while ignoring malformed or reserved extension entries.
 */
export function mergePluginSettings(
  raw?:
    | Partial<PluginSettings>
    | PersistedPluginSettings
    | Record<string, unknown>
    | null
): PluginSettings {
  const defaults = createDefaultSettings();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return defaults;
  }

  const saved = raw as Record<string, unknown>;
  const mergedFileTypes: Record<string, FileTypeConfig> =
    createDefaultFileTypeConfigs();

  if (
    saved.fileTypes &&
    typeof saved.fileTypes === "object" &&
    !Array.isArray(saved.fileTypes)
  ) {
    for (const [rawKey, partial] of Object.entries(
      saved.fileTypes as Record<string, unknown>
    )) {
      if (!partial || typeof partial !== "object" || Array.isArray(partial)) {
        continue;
      }
      const p = partial as Partial<FileTypeConfig>;
      const candidate =
        typeof p.extension === "string" && p.extension.trim().length > 0
          ? p.extension
          : rawKey;
      const validation = validateExtension(candidate);
      if (!validation.valid) {
        continue;
      }
      const ext = validation.extension;
      mergedFileTypes[ext] = resolveFileTypeConfig(ext, p);
    }
  }

  const enableMetadataFiles =
    typeof saved.enableMetadataFiles === "boolean"
      ? saved.enableMetadataFiles
      : defaults.enableMetadataFiles;

  const metadataDirRegex =
    typeof saved.metadataDirRegex === "string"
      ? saved.metadataDirRegex
      : defaults.metadataDirRegex;

  const metadataFrontmatterKey =
    typeof saved.metadataFrontmatterKey === "string" &&
    saved.metadataFrontmatterKey.trim().length > 0
      ? saved.metadataFrontmatterKey.trim()
      : defaults.metadataFrontmatterKey;

  const metadataDefaultTags = Array.isArray(saved.metadataDefaultTags)
    ? saved.metadataDefaultTags
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    : [...defaults.metadataDefaultTags];

  const autoRunExtractorOnCreate =
    typeof saved.autoRunExtractorOnCreate === "boolean"
      ? saved.autoRunExtractorOnCreate
      : defaults.autoRunExtractorOnCreate;

  return {
    fileTypes: mergedFileTypes,
    enableMetadataFiles,
    metadataDirRegex,
    metadataFrontmatterKey,
    metadataDefaultTags,
    autoRunExtractorOnCreate,
  };
}

/**
 * Produce a clean JSON-serializable payload of PluginSettings for persistence in data.json.
 * For built-in presets, only user-overridable fields (`extension`, `badgeLabel`, `tabMode`,
 * `embedMode`, `enabled`, and optional overridden `extractorId`) are persisted.
 * For custom user-added extensions, the full validated `FileTypeConfig` is persisted.
 */
export function serializePluginSettings(
  settings: PluginSettings | PersistedPluginSettings
): PersistedPluginSettings {
  const normalized = mergePluginSettings(settings);
  const fileTypes: Record<string, BuiltInFileTypeOverride | FileTypeConfig> =
    {};

  for (const [ext, cfg] of Object.entries(normalized.fileTypes)) {
    if (isBuiltInExtension(ext)) {
      const preset = DEFAULT_FILE_TYPE_PRESETS[ext];
      const override: BuiltInFileTypeOverride = {
        extension: cfg.extension,
        badgeLabel: cfg.badgeLabel,
        tabMode: cfg.tabMode,
        embedMode: cfg.embedMode,
        enabled: cfg.enabled,
      };
      if (cfg.extractorId && cfg.extractorId !== preset.extractorId) {
        override.extractorId = cfg.extractorId;
      }
      fileTypes[ext] = override;
    } else {
      fileTypes[ext] = {
        extension: cfg.extension,
        category: cfg.category,
        badgeLabel: cfg.badgeLabel,
        languageId: cfg.languageId,
        syntaxLanguage: cfg.syntaxLanguage ?? cfg.languageId,
        rendererId: cfg.rendererId,
        tabMode: cfg.tabMode,
        embedMode: cfg.embedMode,
        enabled: cfg.enabled,
        extractorId: cfg.extractorId,
        isCustom: true,
      };
    }
  }

  return {
    fileTypes,
    enableMetadataFiles: normalized.enableMetadataFiles,
    metadataDirRegex: normalized.metadataDirRegex,
    metadataFrontmatterKey: normalized.metadataFrontmatterKey,
    metadataDefaultTags: [...normalized.metadataDefaultTags],
    autoRunExtractorOnCreate: normalized.autoRunExtractorOnCreate,
  };
}
