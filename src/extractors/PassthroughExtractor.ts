import type { App, TFile } from "obsidian";
import type {
  ContentExtractorAdapter,
  ContentExtractorResult,
  FileTypeConfig,
} from "../types/contracts";

export const DEFAULT_EXTRACTOR_ID = "passthrough";
export const NOOP_EXTRACTOR_ID = "noop";
export const NONE_EXTRACTOR_ID = "none";

export const PASSTHROUGH_EXTRACTOR_ALIASES: ReadonlySet<string> = new Set([
  DEFAULT_EXTRACTOR_ID,
  NOOP_EXTRACTOR_ID,
  NONE_EXTRACTOR_ID,
]);

export function isPassthroughExtractorAlias(id?: string | null): boolean {
  if (!id || typeof id !== "string") {
    return false;
  }
  return PASSTHROUGH_EXTRACTOR_ALIASES.has(id.trim());
}

/**
 * Default no-op passthrough content extractor adapter.
 * Performs a safe no-op (`skipBodyUpdate: true`) so companion `.md` notes
 * preserve all user-authored YAML frontmatter and manual Markdown notes
 * unless a concrete content extractor is configured for that file type.
 */
export class NoOpPassthroughExtractor implements ContentExtractorAdapter {
  readonly id: string;

  constructor(id: string = DEFAULT_EXTRACTOR_ID) {
    this.id = id;
  }

  supports(file: TFile, config: FileTypeConfig): boolean {
    if (!file || typeof file.path !== "string") {
      return false;
    }
    if (!config) {
      return true;
    }
    const requested = config.extractorId?.trim();
    return (
      !requested ||
      requested === this.id ||
      isPassthroughExtractorAlias(requested)
    );
  }

  async extract(
    _file: TFile,
    _app: App,
    _config?: FileTypeConfig
  ): Promise<ContentExtractorResult> {
    return {
      markdownBody: "",
      skipBodyUpdate: true,
    };
  }
}

export { NoOpPassthroughExtractor as PassthroughExtractor };
