import type { App, TFile } from "obsidian";

/**
 * Edit mode supported by file tabs and inline embeds.
 */
export type EditMode = "editable" | "readonly";

/**
 * Logical grouping category for a supported file type.
 */
export type FileCategory =
  | "text"
  | "code"
  | "data"
  | "log"
  | "patch"
  | "binary"
  | "custom";

/**
 * Configuration entry for a single registered file extension.
 */
export interface FileTypeConfig {
  /** Lowercase file extension without leading dot (e.g. 'log', 'patch', 'c', 'rb', 'json', 'txt'). */
  extension: string;
  /** High-level file category ('text', 'code', 'data', 'log', 'patch', 'binary', 'custom'). */
  category: FileCategory;
  /** Short uppercase badge label rendered in File Explorer (e.g. 'LOG', 'PATCH', 'C', 'RB'). */
  badgeLabel: string;
  /** CodeMirror language identifier or external renderer language key (e.g. 'javascript', 'wasm:hex'). */
  languageId: string;
  /** Optional alias for syntax language matching functional requirements. */
  syntaxLanguage?: string;
  /** Renderer adapter ID ('cm6-text' by default; extensible to 'wasm-viewer', etc.). */
  rendererId: string;
  /** Default editability when opened in a dedicated tab ('editable' | 'readonly'). */
  tabMode: EditMode;
  /** Default editability when rendered as an inline ![[file]] embed ('readonly' | 'editable'). */
  embedMode: EditMode;
  /** Whether this file type is enabled for plugin handling. */
  enabled: boolean;
  /** Optional content extractor adapter ID for populating companion .md notes. */
  extractorId?: string;
  /** True if this extension was added by the user rather than built-in presets. */
  isCustom?: boolean;
}

/**
 * Persisted plugin settings structure.
 */
export interface PluginSettings {
  /** Per-file-type configurations keyed by lowercase extension. */
  fileTypes: Record<string, FileTypeConfig>;
  /** Whether companion .md metadata notes are enabled (default: false). */
  enableMetadataFiles: boolean;
  /** Directory regex filter restricting companion metadata functionality to matching folder paths. */
  metadataDirRegex: string;
  /** YAML frontmatter property linking a companion .md note to its target file. */
  metadataFrontmatterKey: string;
  /** Default YAML tags added to newly created companion .md notes. */
  metadataDefaultTags: string[];
  /** Automatically run the configured content extractor when a companion .md note is created. */
  autoRunExtractorOnCreate: boolean;
}

/**
 * Result of resolving a target file's companion .md metadata note.
 */
export interface CompanionPair {
  /** The non-Markdown target file being paired. */
  targetFile: TFile;
  /** Existing resolved companion .md file, or null if not yet created. */
  companionFile: TFile | null;
  /** Expected vault path for the companion note ('<dir>/<name>.md' or '<dir>/<name>.<ext>.md' on collision). */
  expectedCompanionPath: string;
  /** True if '<dir>/<name>.md' collided with an unrelated note and '<dir>/<name>.<ext>.md' was selected. */
  usedFallbackName: boolean;
}

/**
 * Context passed to a RendererAdapter when mounting a tab view or inline embed.
 */
export interface RendererMountContext {
  app: App;
  file: TFile;
  config: FileTypeConfig;
  containerEl: HTMLElement;
  mode: EditMode;
  isEmbed: boolean;
  initialData?: string;
  subpath?: string;
  onContentChange?: (newData: string) => void;
  onOpenMetadata?: (file: TFile) => void;
}

/**
 * Active mounted renderer instance returned by a RendererAdapter.
 */
export interface RendererInstance {
  getValue(): string;
  setValue(data: string): void;
  setMode(mode: EditMode): void;
  getMode(): EditMode;
  focus?(): void;
  destroy(): void;
}

/**
 * Pluggable renderer adapter interface (e.g. CM6 text/code editor, future WASM viewer).
 */
export interface RendererAdapter {
  readonly id: string;
  supports?(config: FileTypeConfig): boolean;
  mount(ctx: RendererMountContext): Promise<RendererInstance> | RendererInstance;
}

/**
 *Result produced by a ContentExtractorAdapter.
 */
export interface ContentExtractorResult {
  markdownBody: string;
  frontmatterProps?: Record<string, unknown>;
}

/**
 * Pluggable content extractor adapter interface (e.g. passthrough, OCR, binary metadata parser).
 */
export interface ContentExtractorAdapter {
  readonly id: string;
  supports(file: TFile, config: FileTypeConfig): boolean;
  extract(file: TFile, app: App): Promise<ContentExtractorResult>;
}

/**
 * Event payload for 'file:open'.
 */
export interface FileOpenEventPayload {
  app: App;
  file: TFile;
  config: FileTypeConfig;
  containerEl: HTMLElement;
  mode: EditMode;
  data?: string;
  onContentChange?: (newData: string) => void;
  onOpenMetadata?: (file: TFile) => void;
  instance?: RendererInstance;
}

/**
 * Event payload for 'file:embed'.
 */
export interface FileEmbedEventPayload {
  app: App;
  file: TFile;
  config: FileTypeConfig;
  containerEl: HTMLElement;
  mode: EditMode;
  subpath?: string;
  onOpenFile?: (file: TFile) => void;
  onOpenMetadata?: (file: TFile) => void;
  instance?: RendererInstance;
}

/**
 * Event payload for 'tree:decorate'.
 */
export interface TreeDecorateEventPayload {
  app: App;
  containerEl: HTMLElement;
  filePaths?: string[];
}

/**
 * Event payload for 'metadata:resolve'.
 */
export interface MetadataResolveEventPayload {
  app: App;
  targetFile: TFile;
  pair?: CompanionPair | null;
}

/**
 * Event payload for 'metadata:open-or-create'.
 */
export interface MetadataOpenOrCreateEventPayload {
  app: App;
  targetFile: TFile;
  openInNewLeaf?: boolean;
  companionFile?: TFile | null;
}

/**
 * Event payload for 'metadata:extract'.
 */
export interface MetadataExtractEventPayload {
  app: App;
  targetFile: TFile;
  companionFile: TFile;
  config?: FileTypeConfig;
  result?: ContentExtractorResult | null;
}

/**
 * Event payload for 'config:updated'.
 */
export interface ConfigUpdatedEventPayload {
  settings: PluginSettings;
  changedExtensions?: string[];
  previousSettings?: PluginSettings;
}

/**
 * Central typed event map for FileSupportEventBus.
 */
export interface FileSupportEventMap {
  "file:open": FileOpenEventPayload;
  "file:embed": FileEmbedEventPayload;
  "tree:decorate": TreeDecorateEventPayload;
  "metadata:resolve": MetadataResolveEventPayload;
  "metadata:open-or-create": MetadataOpenOrCreateEventPayload;
  "metadata:extract": MetadataExtractEventPayload;
  "config:updated": ConfigUpdatedEventPayload;
}

export type FileSupportEventName = keyof FileSupportEventMap;
