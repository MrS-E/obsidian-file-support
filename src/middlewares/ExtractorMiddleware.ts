import { App, Notice, TFile, normalizePath } from "obsidian";
import type { EventBus, NextFn, UnsubscribeFn } from "../core/EventBus";
import {
  FileTypeRegistry,
  normalizeExtension,
  resolveFileTypeConfig,
} from "../core/FileTypeRegistry";
import { ExtractorRegistry } from "../extractors/ExtractorRegistry";
import { DEFAULT_EXTRACTOR_ID } from "../extractors/PassthroughExtractor";
import {
  LazyPairResolver,
  mergeFrontmatterTags,
} from "../metadata/LazyPairResolver";
import type {
  ContentExtractorAdapter,
  ContentExtractorResult,
  FileTypeConfig,
  MetadataExtractEventPayload,
} from "../types/contracts";

export const EXTRACTED_SECTION_START_MARKER =
  "<!-- file-support:extracted:start -->";
export const EXTRACTED_SECTION_END_MARKER =
  "<!-- file-support:extracted:end -->";

export const REFRESH_EXTRACTED_METADATA_COMMAND_ID =
  "refresh-extracted-metadata-content";
export const REFRESH_EXTRACTED_METADATA_TITLE =
  "Refresh extracted metadata content";
export const REFRESH_EXTRACTED_METADATA_ICON = "refresh-cw";

const FRONTMATTER_PREFIX_REGEX =
  /^(\uFEFF?---[ \t]*\n(?:[\s\S]*?\n)?(?:---|\.\.\.)[ \t]*(?:\n|$))/;

const MANAGED_EXTRACTED_BLOCK_REGEX =
  /<!-- file-support:extracted:start -->(?:(?!<!-- file-support:extracted:start -->)[\s\S])*?<!-- file-support:extracted:end -->/;

/**
 * Split a Markdown document into its leading YAML frontmatter block (if present at byte 0)
 * and the remaining Markdown body.
 */
export function splitMarkdownFrontmatterAndBody(markdown: string): {
  frontmatterPrefix: string;
  bodyContent: string;
} {
  const normalized = (markdown ?? "").replace(/\r\n/g, "\n");
  const match = FRONTMATTER_PREFIX_REGEX.exec(normalized);
  if (match && match.index === 0) {
    const frontmatterPrefix = match[1];
    return {
      frontmatterPrefix,
      bodyContent: normalized.slice(frontmatterPrefix.length),
    };
  }
  return {
    frontmatterPrefix: "",
    bodyContent: normalized,
  };
}

/**
 * Format extracted Markdown text inside the delimited managed block:
 * `<!-- file-support:extracted:start --> ... <!-- file-support:extracted:end -->`.
 */
export function formatExtractedMarkdownBlock(extractedBody: string): string {
  const normalized = (extractedBody ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\n+$/, "");
  if (normalized.length === 0) {
    return `${EXTRACTED_SECTION_START_MARKER}\n${EXTRACTED_SECTION_END_MARKER}`;
  }
  return `${EXTRACTED_SECTION_START_MARKER}\n${normalized}\n${EXTRACTED_SECTION_END_MARKER}`;
}

/**
 * Return `true` if `markdown` contains a valid managed extraction block outside YAML frontmatter.
 */
export function hasExtractedMarkdownSection(markdown: string): boolean {
  if (!markdown || typeof markdown !== "string") {
    return false;
  }
  const { bodyContent } = splitMarkdownFrontmatterAndBody(markdown);
  return MANAGED_EXTRACTED_BLOCK_REGEX.test(bodyContent);
}

/**
 * Read the inner text of the managed extraction block in `markdown`, or `null` if no block exists.
 */
export function readExtractedMarkdownSection(markdown: string): string | null {
  if (!markdown || typeof markdown !== "string") {
    return null;
  }
  const { bodyContent } = splitMarkdownFrontmatterAndBody(markdown);
  const match = MANAGED_EXTRACTED_BLOCK_REGEX.exec(bodyContent);
  if (!match) {
    return null;
  }
  const inner = match[0]
    .slice(
      EXTRACTED_SECTION_START_MARKER.length,
      match[0].length - EXTRACTED_SECTION_END_MARKER.length
    )
    .replace(/^\n/, "")
    .replace(/\n$/, "");
  return inner;
}

/**
 * Non-destructively insert or update the managed `<!-- file-support:extracted:start --> ... <!-- file-support:extracted:end -->`
 * section inside a companion `.md` document.
 *
 * Guarantees:
 * - Preserves YAML frontmatter at the top of the document verbatim.
 * - Preserves all user-authored Markdown text before and after the managed block verbatim.
 * - Avoids `String.prototype.replace` `$` interpolation hazards by slicing directly on match indices.
 * - Strictly idempotent: calling `updateExtractedMarkdownSection` repeatedly with the same
 *   `extractedBody` produces the exact same string.
 */
export function updateExtractedMarkdownSection(
  existingMarkdown: string,
  extractedBody: string
): string {
  const { frontmatterPrefix, bodyContent } =
    splitMarkdownFrontmatterAndBody(existingMarkdown);
  const formattedBlock = formatExtractedMarkdownBlock(extractedBody);

  const match = MANAGED_EXTRACTED_BLOCK_REGEX.exec(bodyContent);
  if (match) {
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;
    const updatedBody =
      bodyContent.slice(0, matchStart) +
      formattedBlock +
      bodyContent.slice(matchEnd);
    return frontmatterPrefix + updatedBody;
  }

  // No existing valid managed block pair in bodyContent.
  // Strip any stray/unmatched single marker lines so future updates never span across user prose.
  const cleanedBody = bodyContent
    .replace(/^[ \t]*<!-- file-support:extracted:start -->[ \t]*\n?/gm, "")
    .replace(/^[ \t]*<!-- file-support:extracted:end -->[ \t]*\n?/gm, "");

  if (cleanedBody.trim().length === 0) {
    if (frontmatterPrefix.length > 0) {
      const normalizedFm = frontmatterPrefix.endsWith("\n")
        ? frontmatterPrefix
        : `${frontmatterPrefix}\n`;
      return `${normalizedFm}\n${formattedBlock}\n`;
    }
    return `${formattedBlock}\n`;
  }

  const bodyWithoutTrailingBlank = cleanedBody.replace(/[ \t]*\n+$/, "");
  if (
    frontmatterPrefix.length > 0 &&
    !bodyWithoutTrailingBlank.startsWith("\n")
  ) {
    const normalizedFm = frontmatterPrefix.endsWith("\n")
      ? frontmatterPrefix
      : `${frontmatterPrefix}\n`;
    return `${normalizedFm}\n${bodyWithoutTrailingBlank}\n\n${formattedBlock}\n`;
  }

  return `${frontmatterPrefix}${bodyWithoutTrailingBlank}\n\n${formattedBlock}\n`;
}

/**
 * Middleware listening for `metadata:extract` events on the central `EventBus`,
 * routing extraction requests to registered `ContentExtractorAdapter` implementations,
 * and non-destructively updating the managed Markdown section and optional frontmatter
 * properties in the companion `.md` note.
 */
export class ExtractorMiddleware {
  readonly id = "content-extractor";
  private app: App;
  private extractorRegistry: ExtractorRegistry;
  private fileTypeRegistry?: FileTypeRegistry;
  private pairResolver?: LazyPairResolver;
  private unsubscribers: UnsubscribeFn[] = [];
  private inFlightByCompanionPath: Map<string, Promise<void>> = new Map();

  constructor(
    app: App,
    extractorRegistry: ExtractorRegistry = new ExtractorRegistry(),
    fileTypeRegistry?: FileTypeRegistry,
    pairResolver?: LazyPairResolver
  ) {
    this.app = app;
    this.extractorRegistry = extractorRegistry;
    this.fileTypeRegistry = fileTypeRegistry;
    this.pairResolver = pairResolver;
  }

  setApp(app: App): void {
    this.app = app;
    this.pairResolver?.setApp(app);
  }

  getExtractorRegistry(): ExtractorRegistry {
    return this.extractorRegistry;
  }

  /**
   * Register the `metadata:extract` middleware on the central `EventBus`.
   */
  register(eventBus: EventBus): UnsubscribeFn {
    this.cleanupSubscriptions();
    this.unsubscribers.push(
      eventBus.use("metadata:extract", (payload, next) =>
        this.handleMetadataExtract(payload, next)
      )
    );
    return () => {
      this.destroy();
    };
  }

  destroy(): void {
    this.cleanupSubscriptions();
    this.inFlightByCompanionPath.clear();
  }

  private handleMetadataExtract(
    payload: MetadataExtractEventPayload,
    next: NextFn
  ): Promise<void> | void {
    if (!payload || !payload.targetFile) {
      if (payload) {
        payload.result = null;
      }
      return next();
    }

    const activeApp = payload.app ?? this.app;
    const targetFile = payload.targetFile;
    let companionFile = payload.companionFile;

    if (!companionFile && this.pairResolver) {
      const resolvedPair = this.pairResolver.resolve(targetFile);
      if (resolvedPair?.companionFile) {
        companionFile = resolvedPair.companionFile;
        payload.companionFile = companionFile;
      }
    }

    if (!companionFile) {
      payload.result = null;
      return next();
    }

    const config = this.resolveFileTypeConfigForTarget(
      targetFile,
      payload.config
    );
    if (!config || config.enabled === false) {
      payload.result = null;
      return next();
    }
    payload.config = config;

    const adapter = this.extractorRegistry.resolve(targetFile, config);
    if (!adapter) {
      payload.result = null;
      return next();
    }

    return (async () => {
      const normCompanionPath = normalizePath(companionFile.path);
      const previousTask =
        this.inFlightByCompanionPath.get(normCompanionPath) ??
        Promise.resolve();

      const currentTask = previousTask
        .catch(() => {
          // Do not allow an earlier failed extraction to block queued requests
        })
        .then(() =>
          this.executeExtractionForCompanion(
            activeApp,
            targetFile,
            companionFile,
            config,
            adapter
          )
        );

      const queueMarker = currentTask.then(
        () => undefined,
        () => undefined
      );
      this.inFlightByCompanionPath.set(normCompanionPath, queueMarker);

      try {
        payload.result = await currentTask;
      } finally {
        if (
          this.inFlightByCompanionPath.get(normCompanionPath) === queueMarker
        ) {
          this.inFlightByCompanionPath.delete(normCompanionPath);
        }
      }

      await next();
    })();
  }

  private async executeExtractionForCompanion(
    activeApp: App,
    targetFile: TFile,
    companionFile: TFile,
    config: FileTypeConfig,
    adapter: ContentExtractorAdapter
  ): Promise<ContentExtractorResult | null> {
    try {
      const rawResult = await adapter.extract(targetFile, activeApp, config);
      if (!rawResult || typeof rawResult !== "object") {
        return null;
      }

      const result: ContentExtractorResult = {
        markdownBody:
          typeof rawResult.markdownBody === "string"
            ? rawResult.markdownBody
            : "",
        ...(rawResult.frontmatterProps !== undefined
          ? { frontmatterProps: rawResult.frontmatterProps }
          : {}),
        ...(rawResult.skipBodyUpdate !== undefined
          ? { skipBodyUpdate: rawResult.skipBodyUpdate }
          : {}),
      };

      const hasFrontmatterProps =
        Boolean(result.frontmatterProps) &&
        typeof result.frontmatterProps === "object" &&
        Object.keys(result.frontmatterProps!).length > 0;

      // 1. Update YAML frontmatter properties first if provided by the extractor
      if (hasFrontmatterProps) {
        await this.applyExtractedFrontmatterProps(
          activeApp,
          companionFile,
          targetFile,
          result.frontmatterProps!
        );
      }

      // 2. Update the managed Markdown body block unless the extractor is a no-op
      if (!result.skipBodyUpdate) {
        const currentContent =
          typeof activeApp?.vault?.read === "function"
            ? await activeApp.vault.read(companionFile)
            : "";

        // If the extracted body is empty and the companion note has no existing managed block,
        // treat as a no-op so user content is never modified unnecessarily.
        const shouldUpdateBody =
          result.markdownBody.length > 0 ||
          hasExtractedMarkdownSection(currentContent);

        if (shouldUpdateBody) {
          const updatedContent = updateExtractedMarkdownSection(
            currentContent,
            result.markdownBody
          );
          if (
            updatedContent !== currentContent &&
            typeof activeApp?.vault?.modify === "function"
          ) {
            await activeApp.vault.modify(companionFile, updatedContent);
          }
        }
      }

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[FileSupport] Content extraction failed for "${targetFile?.path ?? ""}" (adapter "${adapter?.id ?? "unknown"}"):`,
        err
      );
      new Notice(
        `Failed to extract metadata content for "${targetFile?.name ?? "file"}": ${message}`
      );
      return null;
    }
  }

  private async applyExtractedFrontmatterProps(
    activeApp: App,
    companionFile: TFile,
    targetFile: TFile,
    frontmatterProps: Record<string, unknown>
  ): Promise<void> {
    if (this.pairResolver) {
      await this.pairResolver.writeCompanionFrontmatter(
        companionFile,
        targetFile,
        frontmatterProps,
        undefined,
        { includeDefaultTags: false }
      );
      return;
    }

    if (typeof activeApp?.fileManager?.processFrontMatter === "function") {
      await activeApp.fileManager.processFrontMatter(
        companionFile,
        (fm: Record<string, any>) => {
          for (const [key, value] of Object.entries(frontmatterProps)) {
            if (key === "tags" && Array.isArray(value)) {
              const existingTags =
                fm.tags !== undefined
                  ? fm.tags
                  : fm.tag !== undefined
                    ? fm.tag
                    : [];
              fm.tags = mergeFrontmatterTags(
                existingTags,
                value.filter((t): t is string => typeof t === "string")
              );
              if (fm.tag !== undefined) {
                delete fm.tag;
              }
            } else {
              fm[key] = value;
            }
          }
        }
      );
    }
  }

  private resolveFileTypeConfigForTarget(
    targetFile: TFile,
    explicitConfig?: FileTypeConfig
  ): FileTypeConfig | null {
    if (explicitConfig) {
      return explicitConfig;
    }
    const fromRegistry = this.fileTypeRegistry?.getForFile(targetFile);
    if (fromRegistry) {
      return fromRegistry;
    }
    const fromResolver = this.pairResolver?.getFileTypeConfig(targetFile);
    if (fromResolver) {
      return fromResolver;
    }
    const ext = normalizeExtension(targetFile?.extension || "txt") || "txt";
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

  private cleanupSubscriptions(): void {
    for (const unsub of this.unsubscribers.splice(0)) {
      try {
        unsub();
      } catch {
        // Ignore unsubscribe cleanup errors
      }
    }
  }
}
