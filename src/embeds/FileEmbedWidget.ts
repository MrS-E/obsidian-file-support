import {
  EditorState,
  RangeSetBuilder,
  StateField,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import {
  App,
  MarkdownPostProcessorContext,
  MarkdownRenderChild,
  TFile,
  normalizePath,
  setIcon,
} from "obsidian";
import type { EventBus, UnsubscribeFn } from "../core/EventBus";
import {
  FileTypeRegistry,
  normalizeExtension,
  resolveFileTypeConfig,
} from "../core/FileTypeRegistry";
import type {
  ConfigUpdatedEventPayload,
  EditMode,
  FileEmbedEventPayload,
  FileTypeConfig,
  PluginSettings,
  RendererInstance,
} from "../types/contracts";

export interface FileSupportEmbedHost {
  app: App;
  settings: PluginSettings;
  registry: FileTypeRegistry;
  eventBus: EventBus;
  isExtensionRegisteredInEmbedRegistry?(extension: string): boolean;
}

export interface EmbedInfo {
  app?: App;
  containerEl: HTMLElement;
  linktext?: string;
  sourcePath?: string;
}

export type ObsidianEmbedCreator = (
  info: EmbedInfo,
  file: TFile,
  subpath: string
) => FileEmbedWidget;

export interface ObsidianEmbedRegistry {
  embedByExtension?: Record<string, ObsidianEmbedCreator>;
  registerExtensions?: (
    extensions: string[],
    creator: ObsidianEmbedCreator
  ) => void;
  registerExtension?: (
    extension: string,
    creator: ObsidianEmbedCreator
  ) => void;
  unregisterExtensions?: (extensions: string[]) => void;
  unregisterExtension?: (extension: string) => void;
}

export interface ParsedEmbedLink {
  linkpath: string;
  subpath?: string;
  alias?: string;
}

const WIKI_EMBED_PATTERN =
  /!\[\[([^\]|#\n]+)(?:#([^\]|\n]+))?(?:\|([^\]]+))?\]\]/g;

/**
 * Parse a raw linktext or `![[file.ext#subpath|alias]]` string into linkpath, subpath, and alias.
 */
export function parseEmbedLinktext(raw: string): ParsedEmbedLink | null {
  if (typeof raw !== "string") {
    return null;
  }
  let trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("![[") && trimmed.endsWith("]]")) {
    trimmed = trimmed.slice(3, -2).trim();
  } else if (trimmed.startsWith("[[") && trimmed.endsWith("]]")) {
    trimmed = trimmed.slice(2, -2).trim();
  }
  if (!trimmed) {
    return null;
  }

  let alias: string | undefined;
  const pipeIdx = trimmed.indexOf("|");
  if (pipeIdx !== -1) {
    alias = trimmed.slice(pipeIdx + 1).trim() || undefined;
    trimmed = trimmed.slice(0, pipeIdx).trim();
  }

  let subpath: string | undefined;
  const hashIdx = trimmed.indexOf("#");
  if (hashIdx !== -1) {
    subpath = trimmed.slice(hashIdx + 1).trim() || undefined;
    trimmed = trimmed.slice(0, hashIdx).trim();
  }

  if (!trimmed) {
    return null;
  }

  return {
    linkpath: trimmed,
    subpath,
    alias,
  };
}

function isTFileLike(candidate: unknown): candidate is TFile {
  if (!candidate || typeof candidate !== "object") {
    return false;
  }
  const obj = candidate as Record<string, unknown>;
  if (Array.isArray(obj.children)) {
    return false;
  }
  return typeof obj.path === "string" && typeof obj.extension === "string";
}

/**
 * Resolve a linkpath to a vault TFile using `metadataCache.getFirstLinkpathDest`
 * with fallback to `vault.getAbstractFileByPath`.
 */
export function resolveEmbedTargetFile(
  app: App,
  linkpath: string,
  sourcePath: string = ""
): TFile | null {
  if (!app || !linkpath || typeof linkpath !== "string") {
    return null;
  }
  const cleaned = linkpath.trim();
  if (!cleaned) {
    return null;
  }

  const fromCache = app.metadataCache?.getFirstLinkpathDest?.(
    cleaned,
    sourcePath
  );
  if (isTFileLike(fromCache)) {
    return fromCache;
  }

  const normalized = normalizePath(cleaned);
  const direct = app.vault?.getAbstractFileByPath?.(normalized);
  if (isTFileLike(direct)) {
    return direct;
  }

  if (sourcePath && sourcePath.includes("/")) {
    const parentDir = sourcePath.slice(0, sourcePath.lastIndexOf("/"));
    const relativePath = normalizePath(`${parentDir}/${cleaned}`);
    const relative = app.vault?.getAbstractFileByPath?.(relativePath);
    if (isTFileLike(relative)) {
      return relative;
    }
  }

  return null;
}

function clearElement(el: HTMLElement): void {
  if (typeof (el as any).empty === "function") {
    (el as any).empty();
    return;
  }
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
  el.textContent = "";
}

function createEl<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tag: K,
  opts?: {
    cls?: string;
    text?: string;
    attr?: Record<string, string>;
  }
): HTMLElementTagNameMap[K] {
  if (typeof (parent as any).createEl === "function") {
    return (parent as any).createEl(tag, opts);
  }
  const doc = (parent as any).ownerDocument ?? document;
  const child = doc.createElement(tag);
  if (opts?.cls) {
    opts.cls
      .split(/\s+/)
      .filter(Boolean)
      .forEach((c: string) => child.classList.add(c));
  }
  if (opts?.text !== undefined) {
    child.textContent = opts.text;
  }
  if (opts?.attr) {
    for (const [k, v] of Object.entries(opts.attr)) {
      child.setAttribute(k, v);
    }
  }
  parent.appendChild(child);
  return child;
}

export interface FileEmbedWidgetOptions {
  app: App;
  plugin: FileSupportEmbedHost;
  containerEl: HTMLElement;
  file: TFile;
  subpath?: string;
  initialData?: string;
  sourcePath?: string;
}

/**
 * Inline `![[file.ext]]` embed widget extending Obsidian's `MarkdownRenderChild`.
 * Compatible with both `app.embedRegistry` (`loadFile()`) and `registerMarkdownPostProcessor` (`ctx.addChild()`).
 */
export class FileEmbedWidget extends MarkdownRenderChild {
  readonly app: App;
  readonly plugin: FileSupportEmbedHost;
  readonly file: TFile;
  readonly subpath?: string;
  readonly sourcePath?: string;
  private initialData?: string;
  private rendererInstance: RendererInstance | null = null;
  private embedBoxEl: HTMLElement | null = null;
  private badgeEl: HTMLElement | null = null;
  private modeBadgeEl: HTMLElement | null = null;
  private openFileBtnEl: HTMLElement | null = null;
  private metadataBtnEl: HTMLElement | null = null;
  private editorHostEl: HTMLElement | null = null;
  private unsubscribeConfig: UnsubscribeFn | null = null;
  private currentMode: EditMode = "readonly";
  private currentBadgeLabel: string = "";
  private loadPromise: Promise<void> | null = null;
  private unloaded: boolean = false;

  constructor(options: FileEmbedWidgetOptions) {
    super(options.containerEl);
    this.app = options.app ?? options.plugin.app;
    this.plugin = options.plugin;
    this.file = options.file;
    const cleanedSubpath = options.subpath
      ? options.subpath.trim().replace(/^#/, "").trim()
      : "";
    this.subpath = cleanedSubpath.length > 0 ? cleanedSubpath : undefined;
    this.initialData = options.initialData;
    this.sourcePath = options.sourcePath;
  }

  /**
   * Create an Obsidian `embedRegistry` factory callback bound to the plugin host.
   */
  static createEmbedRegistryFactory(
    plugin: FileSupportEmbedHost
  ): ObsidianEmbedCreator {
    return (info: EmbedInfo, file: TFile, subpath: string) => {
      return new FileEmbedWidget({
        app: info?.app ?? plugin.app,
        plugin,
        containerEl: info.containerEl,
        file,
        subpath,
        sourcePath: info?.sourcePath,
      });
    };
  }

  onload(): void {
    super.onload?.();
    this.unloaded = false;
    this.ensureConfigSubscription();
    void this.loadFile();
  }

  /**
   * Called by Obsidian's `embedRegistry` (and idempotently by `onload()`).
   */
  loadFile(): Promise<void> {
    if (this.unloaded) {
      return Promise.resolve();
    }
    if (this.loadPromise) {
      return this.loadPromise;
    }
    this.ensureConfigSubscription();
    this.loadPromise = this.mountEmbed();
    return this.loadPromise;
  }

  onunload(): void {
    this.unloaded = true;
    this.loadPromise = null;
    this.cleanupConfigSubscription();
    this.destroyRenderer();
    if (this.containerEl) {
      this.containerEl.removeAttribute?.("data-file-support-mounted");
      this.containerEl.classList?.remove("file-support-embed-mounted");
    }
    super.onunload?.();
  }

  getMode(): EditMode {
    return this.rendererInstance?.getMode() ?? this.currentMode;
  }

  getRendererInstance(): RendererInstance | null {
    return this.rendererInstance;
  }

  getOpenFileButton(): HTMLElement | null {
    return this.openFileBtnEl;
  }

  getMetadataButton(): HTMLElement | null {
    return this.metadataBtnEl;
  }

  async openTargetFile(targetFile?: TFile): Promise<void> {
    const file = targetFile ?? this.file;
    if (!file) {
      return;
    }
    const leaf = this.app?.workspace?.getLeaf?.(false);
    if (leaf && typeof (leaf as any).openFile === "function") {
      await (leaf as any).openFile(file);
    }
  }

  async openCompanionMetadata(targetFile?: TFile): Promise<void> {
    const file = targetFile ?? this.file;
    if (!file) {
      return;
    }
    await this.plugin.eventBus.emit("metadata:open-or-create", {
      app: this.app,
      targetFile: file,
      openInNewLeaf: false,
    });
  }

  private ensureConfigSubscription(): void {
    if (this.unsubscribeConfig) {
      return;
    }
    this.unsubscribeConfig = this.plugin.eventBus.on(
      "config:updated",
      (payload) => {
        this.handleConfigUpdated(payload);
      }
    );
  }

  private cleanupConfigSubscription(): void {
    if (this.unsubscribeConfig) {
      this.unsubscribeConfig();
      this.unsubscribeConfig = null;
    }
  }

  private resolveConfig(): FileTypeConfig {
    const cfg = this.plugin.registry.getForFile(this.file);
    if (cfg) {
      return cfg;
    }
    return resolveFileTypeConfig(this.file.extension || "txt", {
      tabMode: "readonly",
      embedMode: "readonly",
    });
  }

  private async mountEmbed(): Promise<void> {
    if (this.unloaded || !this.containerEl) {
      return;
    }

    const config = this.resolveConfig();
    const effectiveMode: EditMode = config.enabled
      ? config.embedMode
      : "readonly";
    this.currentMode = effectiveMode;
    this.currentBadgeLabel = config.badgeLabel;

    clearElement(this.containerEl);
    this.containerEl.setAttribute?.("data-file-support-mounted", "true");
    this.containerEl.setAttribute?.("data-extension", config.extension);
    this.containerEl.setAttribute?.("data-edit-mode", effectiveMode);
    this.containerEl.classList?.add("file-support-embed-mounted");

    this.embedBoxEl = createEl(this.containerEl, "div", {
      cls: "file-support-embed-container",
      attr: {
        "data-extension": config.extension,
        "data-edit-mode": effectiveMode,
      },
    });

    const headerEl = createEl(this.embedBoxEl, "div", {
      cls: "file-support-embed-header",
    });

    const titleGroupEl = createEl(headerEl, "div", {
      cls: "file-support-embed-title-group",
    });

    const displayTitle = this.subpath
      ? `${this.file.name}#${this.subpath}`
      : this.file.name;
    createEl(titleGroupEl, "span", {
      cls: "file-support-embed-title",
      text: displayTitle,
      attr: { title: this.file.path },
    });

    this.badgeEl = createEl(titleGroupEl, "span", {
      cls: "nav-file-tag file-support-badge",
      text: config.badgeLabel,
    });

    this.modeBadgeEl = createEl(titleGroupEl, "span", {
      cls: "file-support-embed-mode",
      text: effectiveMode === "editable" ? "Editable" : "Read-only",
      attr: { "data-edit-mode": effectiveMode },
    });

    const actionsEl = createEl(headerEl, "div", {
      cls: "file-support-embed-actions",
    });

    this.openFileBtnEl = createEl(actionsEl, "button", {
      cls: "clickable-icon file-support-embed-open-btn",
      text: "Open file",
      attr: {
        type: "button",
        "aria-label": `Open ${this.file.name}`,
        title: `Open ${this.file.name}`,
        "data-file-support-action": "open-file",
      },
    });
    try {
      if (typeof setIcon === "function") {
        setIcon(this.openFileBtnEl, "lucide-arrow-up-right");
      }
    } catch {
      // Ignore icon helper errors in non-Obsidian test environments
    }
    this.openFileBtnEl.addEventListener("click", (evt) => {
      evt.preventDefault?.();
      evt.stopPropagation?.();
      void this.openTargetFile();
    });

    this.metadataBtnEl = createEl(actionsEl, "button", {
      cls: "clickable-icon file-support-embed-metadata-btn",
      text: "Open metadata",
      attr: {
        type: "button",
        "aria-label": "Open or create companion metadata note",
        title: "Open or create companion metadata note",
        "data-file-support-action": "open-metadata",
      },
    });
    try {
      if (typeof setIcon === "function") {
        setIcon(this.metadataBtnEl, "file-symlink");
      }
    } catch {
      // Ignore icon helper errors in non-Obsidian test environments
    }
    this.metadataBtnEl.addEventListener("click", (evt) => {
      evt.preventDefault?.();
      evt.stopPropagation?.();
      void this.openCompanionMetadata();
    });
    this.updateMetadataButtonState();

    this.editorHostEl = createEl(this.embedBoxEl, "div", {
      cls: "file-support-embed-editor",
      attr: {
        "data-extension": config.extension,
        "data-edit-mode": effectiveMode,
      },
    });

    const payload: FileEmbedEventPayload = {
      app: this.app,
      file: this.file,
      config,
      containerEl: this.editorHostEl,
      mode: effectiveMode,
      subpath: this.subpath,
      data: this.initialData,
      onOpenFile: (f: TFile) => {
        void this.openTargetFile(f);
      },
      onOpenMetadata: (f: TFile) => {
        void this.openCompanionMetadata(f);
      },
    };

    const resolved = await this.plugin.eventBus.emit("file:embed", payload);
    if (this.unloaded) {
      resolved.instance?.destroy();
      return;
    }

    if (resolved.instance) {
      this.rendererInstance = resolved.instance;
      if (this.rendererInstance.getMode() !== this.currentMode) {
        this.rendererInstance.setMode(this.currentMode);
      }
    }
  }

  private updateMetadataButtonState(): void {
    if (!this.metadataBtnEl) {
      return;
    }
    const enabled = Boolean(this.plugin.settings?.enableMetadataFiles);
    this.metadataBtnEl.classList?.toggle("is-disabled", !enabled);
    this.metadataBtnEl.setAttribute?.(
      "aria-disabled",
      enabled ? "false" : "true"
    );
  }

  private handleConfigUpdated(payload: ConfigUpdatedEventPayload): void {
    if (this.unloaded) {
      return;
    }
    this.updateMetadataButtonState();

    const fileExt = normalizeExtension(this.file.extension);
    if (Array.isArray(payload.changedExtensions)) {
      const affectsThisEmbed = payload.changedExtensions.some(
        (ext) => normalizeExtension(ext) === fileExt
      );
      if (!affectsThisEmbed) {
        return;
      }
    }

    const updatedConfig = this.plugin.registry.get(fileExt);
    if (
      updatedConfig &&
      this.badgeEl &&
      updatedConfig.badgeLabel !== this.currentBadgeLabel
    ) {
      this.currentBadgeLabel = updatedConfig.badgeLabel;
      this.badgeEl.textContent = updatedConfig.badgeLabel;
    }

    const nextMode: EditMode =
      updatedConfig && updatedConfig.enabled
        ? updatedConfig.embedMode
        : "readonly";

    if (
      this.currentMode === nextMode &&
      this.rendererInstance?.getMode() === nextMode
    ) {
      return;
    }

    this.currentMode = nextMode;
    this.containerEl?.setAttribute?.("data-edit-mode", nextMode);
    this.embedBoxEl?.setAttribute?.("data-edit-mode", nextMode);
    this.editorHostEl?.setAttribute?.("data-edit-mode", nextMode);
    if (this.modeBadgeEl) {
      this.modeBadgeEl.textContent =
        nextMode === "editable" ? "Editable" : "Read-only";
      this.modeBadgeEl.setAttribute?.("data-edit-mode", nextMode);
    }
    this.rendererInstance?.setMode(nextMode);
  }

  private destroyRenderer(): void {
    if (this.rendererInstance) {
      const inst = this.rendererInstance;
      this.rendererInstance = null;
      inst.destroy();
    }
  }
}

/**
 * Find all `.internal-embed` elements within `root` (including `root` itself),
 * supporting both standard DOM `querySelectorAll` and lightweight mock element trees.
 */
export function findInternalEmbedElements(root: HTMLElement): HTMLElement[] {
  const results: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();

  const addIfEmbed = (el: any) => {
    if (
      el &&
      typeof el === "object" &&
      !seen.has(el) &&
      el.classList?.contains?.("internal-embed")
    ) {
      seen.add(el);
      results.push(el);
    }
  };

  addIfEmbed(root);

  if (typeof (root as any)?.querySelectorAll === "function") {
    const nodeList = (root as any).querySelectorAll(".internal-embed");
    if (nodeList) {
      for (const item of Array.from(nodeList as Iterable<HTMLElement>)) {
        addIfEmbed(item);
      }
    }
  }

  const walkChildren = (node: any) => {
    if (!node || !Array.isArray(node.children)) {
      return;
    }
    for (const child of node.children) {
      addIfEmbed(child);
      walkChildren(child);
    }
  };
  walkChildren(root);

  return results;
}

/**
 * Markdown post-processor fallback for Reading Mode (and unhydrated `.internal-embed` blocks).
 * Handles both `<span class="internal-embed" src="file.ext">` elements and raw `![[file.ext]]`
 * wiki-embed syntax when not already mounted by `app.embedRegistry`.
 */
export async function processMarkdownEmbeds(
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext | undefined,
  plugin: FileSupportEmbedHost
): Promise<FileEmbedWidget[]> {
  if (!el || !plugin) {
    return [];
  }

  const sourcePath = ctx?.sourcePath ?? "";
  const mountedWidgets: FileEmbedWidget[] = [];

  const mountTargetIntoElement = async (
    embedEl: HTMLElement,
    rawTarget: string
  ): Promise<void> => {
    if (embedEl.getAttribute?.("data-file-support-mounted") === "true") {
      return;
    }
    const parsed = parseEmbedLinktext(rawTarget);
    if (!parsed) {
      return;
    }
    const file = resolveEmbedTargetFile(
      plugin.app,
      parsed.linkpath,
      sourcePath
    );
    if (!file || !plugin.registry.isSupported(file.extension)) {
      return;
    }

    const widget = new FileEmbedWidget({
      app: plugin.app,
      plugin,
      containerEl: embedEl,
      file,
      subpath: parsed.subpath,
      sourcePath,
    });
    if (ctx && typeof ctx.addChild === "function") {
      ctx.addChild(widget);
    }
    await widget.loadFile();
    mountedWidgets.push(widget);
  };

  // 1. Hydrate any `.internal-embed` elements inside `el`
  const internalEmbedEls = findInternalEmbedElements(el);
  for (const embedEl of internalEmbedEls) {
    const rawSrc =
      embedEl.getAttribute?.("src") ??
      embedEl.getAttribute?.("data-href") ??
      embedEl.getAttribute?.("alt") ??
      embedEl.textContent ??
      "";
    await mountTargetIntoElement(embedEl, rawSrc);
  }

  // 2. Fallback for raw `![[file.ext]]` syntax in post-processed blocks when no `.internal-embed` was created
  if (
    internalEmbedEls.length === 0 &&
    el.getAttribute?.("data-file-support-mounted") !== "true" &&
    el.tagName !== "CODE" &&
    el.tagName !== "PRE"
  ) {
    const textContent = el.textContent ?? "";
    if (textContent.includes("![[")) {
      const matches = Array.from(textContent.matchAll(WIKI_EMBED_PATTERN));
      for (const match of matches) {
        const fullMatch = match[0];
        const parsed = parseEmbedLinktext(fullMatch);
        if (!parsed) {
          continue;
        }
        const file = resolveEmbedTargetFile(
          plugin.app,
          parsed.linkpath,
          sourcePath
        );
        if (!file || !plugin.registry.isSupported(file.extension)) {
          continue;
        }
        const hostSpan = createEl(el, "div", {
          cls: "internal-embed file-support-postproc-embed",
          attr: { src: fullMatch.slice(3, -2) },
        });
        await mountTargetIntoElement(hostSpan, fullMatch);
      }
    }
  }

  return mountedWidgets;
}

class CM6LivePreviewEmbedWidget extends WidgetType {
  private readonly plugin: FileSupportEmbedHost;
  private readonly file: TFile;
  private readonly subpath?: string;
  private readonly mode: EditMode;
  private activeWidget: FileEmbedWidget | null = null;

  constructor(
    plugin: FileSupportEmbedHost,
    file: TFile,
    subpath: string | undefined,
    mode: EditMode
  ) {
    super();
    this.plugin = plugin;
    this.file = file;
    this.subpath = subpath;
    this.mode = mode;
  }

  eq(other: CM6LivePreviewEmbedWidget): boolean {
    return (
      this.file.path === other.file.path &&
      this.subpath === other.subpath
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const doc = view.dom.ownerDocument ?? document;
    const container = doc.createElement("div");
    container.className = "internal-embed cm-embed-block file-support-lp-embed";
    container.setAttribute(
      "src",
      this.subpath ? `${this.file.path}#${this.subpath}` : this.file.path
    );

    const widget = new FileEmbedWidget({
      app: this.plugin.app,
      plugin: this.plugin,
      containerEl: container,
      file: this.file,
      subpath: this.subpath,
    });
    this.activeWidget = widget;
    (container as any).__fileSupportEmbedWidget = widget;
    widget.load();
    void widget.loadFile();
    return container;
  }

  destroy(dom: HTMLElement): void {
    const widget: FileEmbedWidget | undefined =
      this.activeWidget ?? (dom as any).__fileSupportEmbedWidget;
    this.activeWidget = null;
    delete (dom as any).__fileSupportEmbedWidget;
    widget?.unload();
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export interface LivePreviewEmbedExtensionOptions {
  /**
   * Source path of the Markdown note being edited (optional; resolved from active workspace file if omitted).
   */
  sourcePath?: string;
  /**
   * When true, always render embeds via this CM6 extension even if `app.embedRegistry` is present.
   */
  forceFallback?: boolean;
}

function buildLivePreviewDecorations(
  state: EditorState,
  plugin: FileSupportEmbedHost,
  options?: LivePreviewEmbedExtensionOptions
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const docText = state.doc.toString();
  if (!docText.includes("![[")) {
    return builder.finish();
  }

  const activeFile = (plugin.app?.workspace as any)?.getActiveFile?.();
  const sourcePath =
    options?.sourcePath ??
    (activeFile && typeof activeFile.path === "string" ? activeFile.path : "");

  const regex = new RegExp(WIKI_EMBED_PATTERN.source, "g");
  let match: RegExpExecArray | null;

  while ((match = regex.exec(docText)) !== null) {
    const fullMatch = match[0];
    const parsed = parseEmbedLinktext(fullMatch);
    if (!parsed) {
      continue;
    }

    const file = resolveEmbedTargetFile(
      plugin.app,
      parsed.linkpath,
      sourcePath
    );
    if (!file || !plugin.registry.isSupported(file.extension)) {
      continue;
    }

    // If Obsidian's native embedRegistry already claimed this extension in a live Obsidian session
    // and forceFallback is not enabled, let Obsidian's native livePreviewPlugin mount it via embedRegistry.
    const handledByNativeEmbedRegistry =
      !options?.forceFallback &&
      Boolean((plugin.app as any)?.embedRegistry) &&
      Boolean((plugin.app as any)?.workspace?.activeEditor) &&
      Boolean(plugin.isExtensionRegisteredInEmbedRegistry?.(file.extension));

    if (handledByNativeEmbedRegistry) {
      continue;
    }

    const config = plugin.registry.getForFile(file);
    const mode: EditMode = config ? config.embedMode : "readonly";
    const widgetEndPos = match.index + fullMatch.length;

    builder.add(
      widgetEndPos,
      widgetEndPos,
      Decoration.widget({
        widget: new CM6LivePreviewEmbedWidget(
          plugin,
          file,
          parsed.subpath,
          mode
        ),
        side: 1,
      })
    );
  }

  return builder.finish();
}

/**
 * CodeMirror 6 Live Preview extension that renders `![[file.ext]]` inline embeds
 * inside Markdown editors when `app.embedRegistry` is unavailable or bypassed.
 */
export function createLivePreviewEmbedExtension(
  plugin: FileSupportEmbedHost,
  options?: LivePreviewEmbedExtensionOptions
): Extension {
  return StateField.define<DecorationSet>({
    create(state) {
      return buildLivePreviewDecorations(state, plugin, options);
    },
    update(decorations, tr) {
      if (tr.docChanged) {
        return buildLivePreviewDecorations(tr.state, plugin, options);
      }
      return decorations.map(tr.changes);
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}
