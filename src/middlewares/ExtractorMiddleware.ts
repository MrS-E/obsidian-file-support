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
  /^(\uFEFF?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$))/;

const STANDALONE_START_MARKER_REGEX =
  /^[ \t]*<!-- file-support:extracted:start -->[ \t]*$/;
const STANDALONE_END_MARKER_REGEX =
  /^[ \t]*<!-- file-support:extracted:end -->[ \t]*$/;
const FENCE_OPEN_REGEX = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_REGEX = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

interface ScannedBodyLine {
  startOffset: number;
  contentEndOffset: number;
  lineEndOffset: number;
  text: string;
  inFence: boolean;
  isStartMarker: boolean;
  isEndMarker: boolean;
}

interface ManagedBlockMatch {
  startOffset: number;
  endOffset: number;
  innerStartOffset: number;
  innerEndOffset: number;
}

interface MarkdownBodyScan {
  lines: ScannedBodyLine[];
  unclosedFence: { char: string; length: number } | null;
}

/**
 * Detect the line ending style (`"\r\n"` vs `"\n"`) used in a Markdown document.
 */
export function detectLineEnding(markdown: string): "\r\n" | "\n" {
  return typeof markdown === "string" && markdown.includes("\r\n")
    ? "\r\n"
    : "\n";
}

function scanMarkdownBodyLines(bodyContent: string): MarkdownBodyScan {
  const lines: ScannedBodyLine[] = [];
  const len = bodyContent.length;
  let pos = 0;
  let activeFence: { char: string; length: number } | null = null;

  while (pos < len) {
    const startOffset = pos;
    let contentEndOffset = pos;
    while (
      contentEndOffset < len &&
      bodyContent[contentEndOffset] !== "\n" &&
      bodyContent[contentEndOffset] !== "\r"
    ) {
      contentEndOffset++;
    }

    let lineEndOffset = contentEndOffset;
    if (lineEndOffset < len) {
      if (
        bodyContent[lineEndOffset] === "\r" &&
        lineEndOffset + 1 < len &&
        bodyContent[lineEndOffset + 1] === "\n"
      ) {
        lineEndOffset += 2;
      } else {
        lineEndOffset += 1;
      }
    }

    const text = bodyContent.slice(startOffset, contentEndOffset);
    let inFence = false;

    if (activeFence === null) {
      const openMatch = FENCE_OPEN_REGEX.exec(text);
      if (openMatch) {
        const fenceRun = openMatch[2];
        const fenceChar = fenceRun[0];
        const infoString = openMatch[3];
        if (fenceChar !== "`" || !infoString.includes("`")) {
          activeFence = { char: fenceChar, length: fenceRun.length };
          inFence = true;
        }
      }
    } else {
      inFence = true;
      const closeMatch = FENCE_CLOSE_REGEX.exec(text);
      if (
        closeMatch &&
        closeMatch[1][0] === activeFence.char &&
        closeMatch[1].length >= activeFence.length
      ) {
        activeFence = null;
      }
    }

    const isStartMarker = STANDALONE_START_MARKER_REGEX.test(text);
    const isEndMarker = STANDALONE_END_MARKER_REGEX.test(text);

    lines.push({
      startOffset,
      contentEndOffset,
      lineEndOffset,
      text,
      inFence,
      isStartMarker,
      isEndMarker,
    });

    pos = lineEndOffset;
  }

  return { lines, unclosedFence: activeFence };
}

function findManagedExtractedBlock(
  bodyContent: string
): ManagedBlockMatch | null {
  const { lines } = scanMarkdownBodyLines(bodyContent);
  let openStartLine: ScannedBodyLine | null = null;

  for (const line of lines) {
    if (!line.inFence && line.isStartMarker) {
      openStartLine = line;
    } else if (line.isEndMarker && openStartLine !== null) {
      return {
        startOffset: openStartLine.startOffset,
        endOffset: line.contentEndOffset,
        innerStartOffset: openStartLine.lineEndOffset,
        innerEndOffset: line.startOffset,
      };
    }
  }

  return null;
}

/**
 * Split a Markdown document into its leading YAML frontmatter block (if present at byte 0)
 * and the remaining Markdown body, preserving original line endings (`\r\n` or `\n`) and bytes verbatim.
 */
export function splitMarkdownFrontmatterAndBody(markdown: string): {
  frontmatterPrefix: string;
  bodyContent: string;
} {
  const source = markdown ?? "";
  const match = FRONTMATTER_PREFIX_REGEX.exec(source);
  if (match && match.index === 0) {
    const frontmatterPrefix = match[1];
    return {
      frontmatterPrefix,
      bodyContent: source.slice(frontmatterPrefix.length),
    };
  }
  return {
    frontmatterPrefix: "",
    bodyContent: source,
  };
}

/**
 * Format extracted Markdown text inside the delimited managed block:
 * `<!-- file-support:extracted:start --> ... <!-- file-support:extracted:end -->`.
 */
export function formatExtractedMarkdownBlock(
  extractedBody: string,
  eol: "\r\n" | "\n" = "\n"
): string {
  const normalizedLines = (extractedBody ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/, "")
    .split("\n")
    .map((line) => {
      if (
        STANDALONE_START_MARKER_REGEX.test(line) ||
        STANDALONE_END_MARKER_REGEX.test(line)
      ) {
        return line.replace("<!--", "&lt;!--");
      }
      return line;
    });
  const normalizedBody = normalizedLines.join("\n");
  const normalized = normalizedBody.replace(/\n/g, eol);
  if (normalized.length === 0) {
    return `${EXTRACTED_SECTION_START_MARKER}${eol}${EXTRACTED_SECTION_END_MARKER}`;
  }
  const { unclosedFence } = scanMarkdownBodyLines(normalizedBody);
  const bodyWithClosedFence = unclosedFence
    ? `${normalized}${eol}${unclosedFence.char.repeat(unclosedFence.length)}`
    : normalized;
  return [
    EXTRACTED_SECTION_START_MARKER,
    bodyWithClosedFence,
    EXTRACTED_SECTION_END_MARKER,
  ].join(eol);
}

/**
 * Return `true` if `markdown` contains a valid standalone managed extraction block
 * outside YAML frontmatter and outside fenced code blocks.
 */
export function hasExtractedMarkdownSection(markdown: string): boolean {
  if (!markdown || typeof markdown !== "string") {
    return false;
  }
  const { bodyContent } = splitMarkdownFrontmatterAndBody(markdown);
  return findManagedExtractedBlock(bodyContent) !== null;
}

/**
 * Read the inner text of the managed extraction block in `markdown`, or `null` if no block exists.
 * Ignores marker lines inside fenced code blocks and preserves original line endings.
 */
export function readExtractedMarkdownSection(markdown: string): string | null {
  if (!markdown || typeof markdown !== "string") {
    return null;
  }
  const { bodyContent } = splitMarkdownFrontmatterAndBody(markdown);
  const match = findManagedExtractedBlock(bodyContent);
  if (!match) {
    return null;
  }
  if (match.innerStartOffset >= match.innerEndOffset) {
    return "";
  }
  return bodyContent
    .slice(match.innerStartOffset, match.innerEndOffset)
    .replace(/\r?\n$/, "");
}

/**
 * Non-destructively insert or update the managed `<!-- file-support:extracted:start --> ... <!-- file-support:extracted:end -->`
 * section inside a companion `.md` document.
 *
 * Guarantees:
 * - Preserves YAML frontmatter at the top of the document verbatim.
 * - Preserves original line endings (`\r\n` vs `\n`) and all user-authored text and whitespace verbatim.
 * - Recognizes only standalone marker lines outside fenced code blocks (` ``` ` / `~~~`).
 * - Avoids `String.prototype.replace` `$` interpolation hazards by slicing directly on character offsets.
 * - Strictly idempotent: calling `updateExtractedMarkdownSection` repeatedly with the same
 *   `extractedBody` produces the exact same string.
 */
export function updateExtractedMarkdownSection(
  existingMarkdown: string,
  extractedBody: string
): string {
  const source = existingMarkdown ?? "";
  const eol = detectLineEnding(source);
  const { frontmatterPrefix, bodyContent } =
    splitMarkdownFrontmatterAndBody(source);
  const formattedBlock = formatExtractedMarkdownBlock(extractedBody, eol);

  const match = findManagedExtractedBlock(bodyContent);
  if (match) {
    const updatedBody =
      bodyContent.slice(0, match.startOffset) +
      formattedBlock +
      bodyContent.slice(match.endOffset);
    return frontmatterPrefix + updatedBody;
  }

  // No existing valid managed block pair in bodyContent.
  // Strip any stray/unmatched standalone marker lines outside fences so future updates never
  // span across user prose, while preserving fenced code blocks and all other bytes verbatim.
  const scannedLines = scanMarkdownBodyLines(bodyContent).lines;
  const hasStrayMarkers = scannedLines.some(
    (l) => !l.inFence && (l.isStartMarker || l.isEndMarker)
  );
  const cleanedBody = hasStrayMarkers
    ? scannedLines
        .filter(
          (l) =>
            l.inFence || (!l.isStartMarker && !l.isEndMarker)
        )
        .map((l) => bodyContent.slice(l.startOffset, l.lineEndOffset))
        .join("")
    : bodyContent;

  if (cleanedBody.trim().length === 0) {
    if (frontmatterPrefix.length > 0) {
      const fmEndsWithNewline =
        frontmatterPrefix.endsWith("\n") || frontmatterPrefix.endsWith("\r");
      const normalizedFm = fmEndsWithNewline
        ? frontmatterPrefix
        : `${frontmatterPrefix}${eol}`;
      return `${normalizedFm}${eol}${formattedBlock}${eol}`;
    }
    return `${formattedBlock}${eol}`;
  }

  const { unclosedFence } = scanMarkdownBodyLines(cleanedBody);
  if (unclosedFence !== null) {
    const bodyWithLineEnding = /(?:\r\n|\r|\n)$/.test(cleanedBody)
      ? cleanedBody
      : `${cleanedBody}${eol}`;
    const closingFence = unclosedFence.char.repeat(unclosedFence.length);
    return `${frontmatterPrefix}${bodyWithLineEnding}${closingFence}${eol}${eol}${formattedBlock}${eol}`;
  }

  // Leave frontmatterPrefix and cleanedBody 100% unchanged and append the managed block at the end.
  if (/(?:\r?\n){2}$/.test(cleanedBody)) {
    return `${frontmatterPrefix}${cleanedBody}${formattedBlock}${eol}`;
  }
  if (/\r?\n$/.test(cleanedBody)) {
    return `${frontmatterPrefix}${cleanedBody}${eol}${formattedBlock}${eol}`;
  }
  return `${frontmatterPrefix}${cleanedBody}${eol}${eol}${formattedBlock}${eol}`;
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

      // 2. Atomically update the managed Markdown body block unless the extractor is a no-op
      if (!result.skipBodyUpdate) {
        const computeUpdatedBody = (currentContent: string): string => {
          const source = currentContent ?? "";
          // If the extracted body is empty and the companion note has no existing managed block,
          // treat as a no-op so user content is never modified unnecessarily.
          const shouldUpdateBody =
            result.markdownBody.length > 0 ||
            hasExtractedMarkdownSection(source);
          if (!shouldUpdateBody) {
            return source;
          }
          return updateExtractedMarkdownSection(source, result.markdownBody);
        };

        if (typeof activeApp?.vault?.process === "function") {
          await activeApp.vault.process(companionFile, computeUpdatedBody);
        } else {
          const currentContent =
            typeof activeApp?.vault?.read === "function"
              ? await activeApp.vault.read(companionFile)
              : "";
          const updatedContent = computeUpdatedBody(currentContent);
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
