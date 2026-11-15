import type { App, TFile } from "obsidian";
import type {
  ContentExtractorAdapter,
  ContentExtractorResult,
  FileTypeConfig,
} from "../types/contracts";

export const DEFAULT_EXTRACTOR_ID = "passthrough";
export const NOOP_EXTRACTOR_ID = "noop";

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
      requested === DEFAULT_EXTRACTOR_ID ||
      requested === NOOP_EXTRACTOR_ID ||
      requested === "none"
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
