import {
  createDefaultFileTypeConfigs,
  normalizeExtension,
  resolveFileTypeConfig,
} from "../core/FileTypeRegistry";
import type { FileTypeConfig, PluginSettings } from "../types/contracts";

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
 * Preserves user overrides on built-in extensions as well as custom user-added extensions.
 */
export function mergePluginSettings(
  raw?: Partial<PluginSettings> | Record<string, unknown> | null
): PluginSettings {
  const defaults = createDefaultSettings();
  if (!raw || typeof raw !== "object") {
    return defaults;
  }

  const saved = raw as Partial<PluginSettings>;
  const mergedFileTypes: Record<string, FileTypeConfig> =
    createDefaultFileTypeConfigs();

  if (saved.fileTypes && typeof saved.fileTypes === "object") {
    for (const [rawKey, partial] of Object.entries(saved.fileTypes)) {
      if (!partial || typeof partial !== "object") continue;
      const ext = normalizeExtension(partial.extension || rawKey);
      if (!ext) continue;
      mergedFileTypes[ext] = resolveFileTypeConfig(ext, partial);
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
 * Produce a clean JSON-serializable clone of PluginSettings for persistence.
 */
export function serializePluginSettings(
  settings: PluginSettings
): PluginSettings {
  const normalized = mergePluginSettings(settings);
  const fileTypes: Record<string, FileTypeConfig> = {};
  for (const [ext, cfg] of Object.entries(normalized.fileTypes)) {
    fileTypes[ext] = { ...cfg };
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
