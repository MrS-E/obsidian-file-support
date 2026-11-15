import type { TFile } from "obsidian";
import {
  normalizeExtension,
  resolveFileTypeConfig,
} from "../core/FileTypeRegistry";
import type {
  ContentExtractorAdapter,
  FileTypeConfig,
} from "../types/contracts";
import {
  DEFAULT_EXTRACTOR_ID,
  NONE_EXTRACTOR_ID,
  NOOP_EXTRACTOR_ID,
  NoOpPassthroughExtractor,
} from "./PassthroughExtractor";

function buildFallbackFileTypeConfig(file: TFile): FileTypeConfig {
  const ext = normalizeExtension(file?.extension || "txt") || "txt";
  try {
    return resolveFileTypeConfig(ext);
  } catch {
    return {
      extension: ext,
      category: "custom",
      badgeLabel: ext.toUpperCase() || "FILE",
      languageId: "plaintext",
      syntaxLanguage: "plaintext",
      rendererId: "cm6-text",
      tabMode: "readonly",
      embedMode: "readonly",
      enabled: true,
      extractorId: DEFAULT_EXTRACTOR_ID,
      isCustom: true,
    };
  }
}

/**
 * Pluggable registry of `ContentExtractorAdapter` implementations (e.g. passthrough,
 * custom text/code summarizers, future OCR, external CLI, or WASM metadata extractors).
 *
 * Resolution order in `resolve(file, config)`:
 * 1. Explicit non-default `config.extractorId`: looks up the registered adapter by ID
 *    and verifies `adapter.supports(file, config)`.
 * 2. Registered non-default adapters matching `adapter.supports(file, config)` (allowing
 *    extension/capability-based adapters to match without requiring manual `extractorId` overrides).
 * 3. Default `"passthrough"` (`NoOpPassthroughExtractor`) fallback when `config.extractorId`
 *    is unset or `"passthrough"`.
 */
export class ExtractorRegistry {
  private adapters: Map<string, ContentExtractorAdapter> = new Map();

  constructor(registerDefaults: boolean = true) {
    if (registerDefaults) {
      this.register(new NoOpPassthroughExtractor());
    }
  }

  /**
   * Register or replace a `ContentExtractorAdapter` by its `id`.
   */
  register(adapter: ContentExtractorAdapter): void {
    if (!adapter || typeof adapter.id !== "string" || !adapter.id.trim()) {
      throw new Error("ContentExtractorAdapter must have a non-empty string id.");
    }
    if (typeof adapter.supports !== "function") {
      throw new Error(
        `ContentExtractorAdapter "${adapter.id}" must implement supports(file, config).`
      );
    }
    if (typeof adapter.extract !== "function") {
      throw new Error(
        `ContentExtractorAdapter "${adapter.id}" must implement extract(file, app).`
      );
    }
    this.adapters.set(adapter.id.trim(), adapter);
  }

  /**
   * Unregister an adapter by its `id`.
   */
  unregister(id: string): boolean {
    if (typeof id !== "string") {
      return false;
    }
    return this.adapters.delete(id.trim());
  }

  /**
   * Retrieve a registered adapter by its exact `id` (or built-in passthrough aliases `"noop"` / `"none"`).
   */
  get(id: string): ContentExtractorAdapter | undefined {
    if (typeof id !== "string") {
      return undefined;
    }
    const trimmed = id.trim();
    const direct = this.adapters.get(trimmed);
    if (direct) {
      return direct;
    }
    if (trimmed === NOOP_EXTRACTOR_ID || trimmed === NONE_EXTRACTOR_ID) {
      return this.adapters.get(DEFAULT_EXTRACTOR_ID);
    }
    return undefined;
  }

  /**
   * Return true if an adapter with `id` (or built-in passthrough alias) is registered.
   */
  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  /**
   * Resolve the appropriate `ContentExtractorAdapter` for `file` and `config`.
   */
  resolve(
    file: TFile,
    config?: FileTypeConfig
  ): ContentExtractorAdapter | undefined {
    if (!file || typeof file.path !== "string") {
      return undefined;
    }

    const effectiveConfig = config ?? buildFallbackFileTypeConfig(file);
    if (effectiveConfig.enabled === false) {
      return undefined;
    }

    const requestedId = effectiveConfig.extractorId?.trim();

    // 1. Explicit non-default extractorId lookup (including explicit "noop" / "none" passthrough aliases)
    if (requestedId && requestedId !== DEFAULT_EXTRACTOR_ID) {
      const direct = this.adapters.get(requestedId);
      if (direct && direct.supports(file, effectiveConfig)) {
        return direct;
      }
      if (
        requestedId === NOOP_EXTRACTOR_ID ||
        requestedId === NONE_EXTRACTOR_ID
      ) {
        const passthroughAlias = this.adapters.get(DEFAULT_EXTRACTOR_ID);
        if (
          passthroughAlias &&
          passthroughAlias.supports(file, effectiveConfig)
        ) {
          return passthroughAlias;
        }
      }
      return undefined;
    }

    // 2. Non-default adapters matching via supports(file, effectiveConfig)
    for (const [id, adapter] of this.adapters.entries()) {
      if (id === DEFAULT_EXTRACTOR_ID) {
        continue;
      }
      if (adapter.supports(file, effectiveConfig)) {
        return adapter;
      }
    }

    // 3. Default passthrough adapter fallback
    const passthrough = this.adapters.get(DEFAULT_EXTRACTOR_ID);
    if (passthrough && passthrough.supports(file, effectiveConfig)) {
      return passthrough;
    }

    return undefined;
  }

  /**
   * Alias for `resolve(file, config)`.
   */
  resolveForFile(
    file: TFile,
    config?: FileTypeConfig
  ): ContentExtractorAdapter | undefined {
    return this.resolve(file, config);
  }

  /**
   * Return all registered `ContentExtractorAdapter` instances.
   */
  getAll(): ContentExtractorAdapter[] {
    return Array.from(this.adapters.values());
  }
}
