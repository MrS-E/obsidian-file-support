import {
  App,
  type EventRef,
  Menu,
  TAbstractFile,
  TFile,
  WorkspaceLeaf,
  normalizePath,
} from "obsidian";
import type { EventBus, NextFn, UnsubscribeFn } from "../core/EventBus";
import {
  FileTypeRegistry,
  normalizeExtension,
} from "../core/FileTypeRegistry";
import {
  LazyPairResolver,
  splitFilePath,
} from "../metadata/LazyPairResolver";
import type {
  ConfigUpdatedEventPayload,
  MetadataOpenOrCreateEventPayload,
  TreeDecorateEventPayload,
} from "../types/contracts";

export const COMPANION_CONTEXT_MENU_TITLE =
  "Open/Create companion metadata note";
export const COMPANION_CONTEXT_MENU_ICON = "file-symlink";

export interface FileTreeItemNode {
  filePath: string;
  normalizedPath: string;
  titleEl: HTMLElement;
  navFileEl: HTMLElement;
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

function isElementNode(node: unknown): node is HTMLElement {
  return (
    Boolean(node) &&
    typeof node === "object" &&
    (node as Node).nodeType === 1
  );
}

function isPluginBadgeElement(el: Element): boolean {
  return (
    el.getAttribute?.("data-file-support-badge") === "true" ||
    Boolean(el.classList?.contains?.("file-support-badge"))
  );
}

function isPluginBadgeOrDescendant(node: Node): boolean {
  if (isElementNode(node)) {
    if (isPluginBadgeElement(node)) {
      return true;
    }
    if (typeof node.closest === "function") {
      return Boolean(
        node.closest('[data-file-support-badge="true"], .file-support-badge')
      );
    }
    return false;
  }
  const parent = node.parentElement;
  if (!parent) {
    return false;
  }
  return isPluginBadgeOrDescendant(parent);
}

function setClassIfChanged(
  el: HTMLElement,
  className: string,
  enabled: boolean
): boolean {
  if (!el?.classList) {
    return false;
  }
  const hasClass = el.classList.contains(className);
  if (enabled && !hasClass) {
    el.classList.add(className);
    return true;
  }
  if (!enabled && hasClass) {
    el.classList.remove(className);
    return true;
  }
  return false;
}

function setAttrIfChanged(
  el: HTMLElement,
  attr: string,
  value: string
): boolean {
  if (!el || typeof el.getAttribute !== "function") {
    return false;
  }
  if (el.getAttribute(attr) === value) {
    return false;
  }
  el.setAttribute(attr, value);
  return true;
}

function removeAttrIfPresent(el: HTMLElement, attr: string): boolean {
  if (!el || typeof el.getAttribute !== "function") {
    return false;
  }
  if (el.getAttribute(attr) === null) {
    return false;
  }
  el.removeAttribute(attr);
  return true;
}

/**
 * Collect all file tree item nodes (`.nav-file` / `.nav-file-title` with `data-path`)
 * inside `containerEl`, skipping folder nodes and any detached nodes not inside `containerEl`.
 */
export function collectFileTreeItems(
  containerEl: HTMLElement
): FileTreeItemNode[] {
  if (!containerEl) {
    return [];
  }

  const candidates: HTMLElement[] = [];
  const checkCandidate = (el: unknown) => {
    if (!isElementNode(el)) {
      return;
    }
    if (
      typeof containerEl.contains === "function" &&
      el !== containerEl &&
      !containerEl.contains(el)
    ) {
      return;
    }
    if (
      el.classList?.contains("nav-folder") ||
      el.classList?.contains("nav-folder-title")
    ) {
      return;
    }
    if (
      el.classList?.contains("nav-file-title") ||
      el.classList?.contains("nav-file")
    ) {
      candidates.push(el);
    }
  };

  checkCandidate(containerEl);

  if (typeof containerEl.querySelectorAll === "function") {
    const found = containerEl.querySelectorAll(
      ".nav-file-title[data-path], .nav-file[data-path], .nav-file-title, .nav-file"
    );
    for (const node of Array.from(found)) {
      checkCandidate(node);
    }
  }

  const results: FileTreeItemNode[] = [];
  const seenTitleEls = new Set<HTMLElement>();

  for (const el of candidates) {
    let titleEl: HTMLElement;
    let navFileEl: HTMLElement;

    if (el.classList.contains("nav-file-title")) {
      titleEl = el;
      const closestNavFile =
        typeof el.closest === "function"
          ? (el.closest(".nav-file") as HTMLElement | null)
          : null;
      navFileEl =
        closestNavFile &&
        (closestNavFile === containerEl ||
          containerEl.contains?.(closestNavFile))
          ? closestNavFile
          : el;
    } else {
      navFileEl = el;
      const childTitle =
        typeof el.querySelector === "function"
          ? (el.querySelector(".nav-file-title") as HTMLElement | null)
          : null;
      titleEl = childTitle ?? el;
    }

    if (seenTitleEls.has(titleEl)) {
      continue;
    }

    const rawPath =
      titleEl.getAttribute?.("data-path") ??
      navFileEl.getAttribute?.("data-path") ??
      null;
    if (!rawPath || typeof rawPath !== "string" || !rawPath.trim()) {
      continue;
    }

    seenTitleEls.add(titleEl);
    results.push({
      filePath: rawPath,
      normalizedPath: normalizePath(rawPath),
      titleEl,
      navFileEl,
    });
  }

  return results;
}

/**
 * Middleware managing File Explorer DOM decoration (`tree:decorate`),
 * `.nav-files-container` MutationObserver lifecycle, extension badges (`.nav-file-tag`),
 * companion `.md` hiding (`.is-companion-hidden`), target file underlining (`.has-companion-metadata`),
 * capture-phase modifier-click (`Alt+Click` / `Ctrl+Shift+Click`) navigation, and the
 * `file-menu` context menu action.
 */
export class FileTreeMiddleware {
  readonly id = "file-tree-decorator";
  private app: App;
  private registry: FileTypeRegistry;
  private pairResolver: LazyPairResolver;
  private eventBus: EventBus | null = null;
  private unsubscribers: UnsubscribeFn[] = [];
  private workspaceEventRefs: Array<{
    name: string;
    ref: EventRef;
    fn: (...args: any[]) => any;
  }> = [];
  private vaultEventRefs: Array<{
    name: string;
    ref: EventRef;
    fn: (...args: any[]) => any;
  }> = [];
  private metadataCacheEventRefs: Array<{
    name: string;
    ref: EventRef;
    fn: (...args: any[]) => any;
  }> = [];
  private observersByContainer: Map<HTMLElement, MutationObserver> = new Map();
  private clickHandlersByContainer: Map<
    HTMLElement,
    (evt: MouseEvent) => void
  > = new Map();
  private decoratedContainers: Set<HTMLElement> = new Set();
  private handledClickEvents: WeakSet<Event> = new WeakSet();
  private isDecorating: boolean = false;
  private decorationPassCount: number = 0;

  constructor(
    app: App,
    registry: FileTypeRegistry,
    pairResolver: LazyPairResolver
  ) {
    this.app = app;
    this.registry = registry;
    this.pairResolver = pairResolver;
  }

  setApp(app: App): void {
    this.app = app;
    this.pairResolver.setApp(app);
  }

  /**
   * Return the total number of decoration passes executed (useful for verifying
   * MutationObserver idempotency in tests).
   */
  getDecorationPassCount(): number {
    return this.decorationPassCount;
  }

  /**
   * Register `tree:decorate`, `config:updated`, and `metadata:open-or-create` handlers on the
   * `EventBus`, attach workspace layout / `file-menu` hooks, and begin observing any mounted
   * `.nav-files-container` File Explorer elements.
   */
  register(eventBus: EventBus): UnsubscribeFn {
    this.cleanupSubscriptions();
    this.eventBus = eventBus;

    this.unsubscribers.push(
      eventBus.use("tree:decorate", (payload, next) =>
        this.handleTreeDecorate(payload, next)
      )
    );

    this.unsubscribers.push(
      eventBus.on("config:updated", (payload) =>
        this.handleConfigUpdated(payload)
      )
    );

    this.unsubscribers.push(
      eventBus.on("metadata:open-or-create", (payload) =>
        this.handleMetadataOpenOrCreateCompleted(payload)
      )
    );

    this.registerWorkspaceListeners();
    this.registerVaultAndCacheListeners();
    this.scanAndObserveFileExplorers();

    return () => {
      this.destroy();
    };
  }

  /**
   * Discover all currently mounted File Explorer `.nav-files-container` elements
   * (from both `workspace.getLeavesOfType("file-explorer")` and `document`),
   * attach `MutationObserver` and capture-phase click listeners, and emit `tree:decorate`.
   */
  scanAndObserveFileExplorers(): HTMLElement[] {
    this.pruneDetachedContainers();

    const containers = this.discoverFileExplorerContainers();
    for (const container of containers) {
      this.observeContainer(container);
      void this.emitTreeDecorate(container);
    }
    return containers;
  }

  /**
   * Re-decorate all currently tracked and discovered File Explorer containers.
   */
  async refreshAllFileExplorers(filePaths?: string[]): Promise<void> {
    this.pruneDetachedContainers();
    const discovered = this.discoverFileExplorerContainers();
    for (const container of discovered) {
      this.observeContainer(container);
    }

    const allContainers = new Set<HTMLElement>([
      ...discovered,
      ...Array.from(this.observersByContainer.keys()),
      ...Array.from(this.decoratedContainers),
    ]);

    for (const container of allContainers) {
      if (this.isContainerDetachedFromDocument(container)) {
        this.unobserveContainer(container);
        this.decoratedContainers.delete(container);
        continue;
      }
      await this.emitTreeDecorate(container, filePaths);
    }
  }

  /**
   * Attach a `MutationObserver` and capture-phase click listener to a File Explorer container.
   * Idempotent if the container is already observed.
   */
  observeContainer(containerEl: HTMLElement): void {
    if (!containerEl || !isElementNode(containerEl)) {
      return;
    }
    if (this.isContainerDetachedFromDocument(containerEl)) {
      return;
    }

    this.ensureCaptureClickListener(containerEl);

    if (this.observersByContainer.has(containerEl)) {
      return;
    }

    if (typeof MutationObserver === "undefined") {
      return;
    }

    const observer = new MutationObserver((records) => {
      this.handleMutations(containerEl, records);
    });

    observer.observe(containerEl, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-path"],
    });

    this.observersByContainer.set(containerEl, observer);
  }

  /**
   * Disconnect the `MutationObserver` and remove the capture-phase click listener for `containerEl`.
   */
  unobserveContainer(containerEl: HTMLElement): void {
    const observer = this.observersByContainer.get(containerEl);
    if (observer) {
      try {
        observer.takeRecords();
        observer.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      this.observersByContainer.delete(containerEl);
    }

    const clickHandler = this.clickHandlersByContainer.get(containerEl);
    if (clickHandler) {
      try {
        containerEl.removeEventListener("click", clickHandler, true);
      } catch {
        // Ignore listener removal errors
      }
      this.clickHandlersByContainer.delete(containerEl);
    }
  }

  /**
   * Synchronously decorate all (or specified) file items inside `containerEl`.
   * Applies `.nav-file-tag` extension badges (skipping items that already have a native Obsidian badge),
   * hides verified paired companion `.md` notes with `.is-companion-hidden`, underlines paired target
   * files with `.has-companion-metadata`, and ensures the capture-phase modifier-click listener is attached.
   */
  decorateContainer(containerEl: HTMLElement, filePaths?: string[]): void {
    if (!containerEl || !isElementNode(containerEl)) {
      return;
    }

    if (
      this.observersByContainer.has(containerEl) &&
      this.isContainerDetachedFromDocument(containerEl)
    ) {
      this.unobserveContainer(containerEl);
      this.decoratedContainers.delete(containerEl);
      return;
    }

    this.ensureCaptureClickListener(containerEl);
    this.decoratedContainers.add(containerEl);

    const prevDecorating = this.isDecorating;
    this.isDecorating = true;
    try {
      const items = collectFileTreeItems(containerEl);
      if (items.length === 0) {
        return;
      }

      this.decorationPassCount++;

      const filter = this.buildExpandedPathFilter(filePaths);
      for (const item of items) {
        if (filter && !this.doesItemMatchFilter(item, filter)) {
          continue;
        }
        if (!this.isItemConnectedToContainer(item, containerEl)) {
          continue;
        }
        this.decorateSingleItem(item);
      }
    } finally {
      this.drainObserverRecords();
      this.isDecorating = prevDecorating;
    }
  }

  /**
   * Populate the Obsidian `file-menu` context menu with "Open/Create companion metadata note"
   * when right-clicking an eligible target file while companion metadata is enabled.
   */
  handleFileMenu(
    menu: Menu,
    file: TAbstractFile,
    _source?: string,
    _leaf?: WorkspaceLeaf
  ): void {
    if (!menu || typeof menu.addItem !== "function") {
      return;
    }
    if (!isTFileLike(file)) {
      return;
    }
    if (
      !this.pairResolver.isMetadataEnabled() ||
      !this.pairResolver.isTargetEligible(file)
    ) {
      return;
    }

    menu.addItem((item) => {
      item
        .setTitle(COMPANION_CONTEXT_MENU_TITLE)
        .setIcon(COMPANION_CONTEXT_MENU_ICON)
        .onClick(() => {
          if (!this.eventBus) {
            return;
          }
          void this.eventBus
            .emit("metadata:open-or-create", {
              app: this.app,
              targetFile: file,
              openInNewLeaf: false,
            })
            .catch((err) => {
              console.warn(
                `[FileSupport] Failed to open or create companion note from context menu for "${file.path}":`,
                err
              );
            });
        });
    });
  }

  /**
   * Disconnect all observers, remove DOM listeners, strip plugin-applied badges and classes,
   * and unsubscribe all EventBus / Obsidian workspace & vault hooks.
   */
  destroy(): void {
    this.cleanupSubscriptions();

    for (const container of Array.from(this.observersByContainer.keys())) {
      this.unobserveContainer(container);
    }
    this.observersByContainer.clear();

    for (const [container, handler] of Array.from(
      this.clickHandlersByContainer.entries()
    )) {
      try {
        container.removeEventListener("click", handler, true);
      } catch {
        // Ignore removal errors
      }
    }
    this.clickHandlersByContainer.clear();

    for (const container of Array.from(this.decoratedContainers)) {
      this.cleanContainerDecorations(container);
    }
    this.decoratedContainers.clear();

    this.eventBus = null;
  }

  private handleTreeDecorate(
    payload: TreeDecorateEventPayload,
    next: NextFn
  ): Promise<void> | void {
    if (payload?.containerEl) {
      this.decorateContainer(payload.containerEl, payload.filePaths);
    }
    return next();
  }

  private handleConfigUpdated(_payload: ConfigUpdatedEventPayload): void {
    void this.refreshAllFileExplorers();
  }

  private handleMetadataOpenOrCreateCompleted(
    payload: MetadataOpenOrCreateEventPayload
  ): void {
    if (!payload?.targetFile) {
      return;
    }
    const paths: string[] = [payload.targetFile.path];
    if (payload.companionFile?.path) {
      paths.push(payload.companionFile.path);
    }
    void this.refreshAllFileExplorers(paths);
  }

  private decorateSingleItem(item: FileTreeItemNode): void {
    const parts = splitFilePath(item.normalizedPath);
    const ext = parts.extension;

    // 1. Extension badge (.nav-file-tag)
    this.syncItemBadge(item, ext);

    // 2. Companion metadata hiding (.is-companion-hidden) & target underlining (.has-companion-metadata)
    this.syncItemCompanionDecoration(item, ext);
  }

  /**
   * Idempotently synchronize the `.nav-file-tag` extension badge on a file tree item.
   * Respects any native Obsidian `.nav-file-tag` already present on the element.
   */
  private syncItemBadge(item: FileTreeItemNode, extension: string): void {
    const { titleEl } = item;
    const config = extension ? this.registry.get(extension) : undefined;
    const isEnabledSupportedType = Boolean(config && config.enabled);

    const existingTagEls =
      typeof titleEl.querySelectorAll === "function"
        ? Array.from(
            titleEl.querySelectorAll(".nav-file-tag") as NodeListOf<HTMLElement>
          )
        : [];

    const nativeTagEls: HTMLElement[] = [];
    const pluginTagEls: HTMLElement[] = [];

    for (const tagEl of existingTagEls) {
      if (isPluginBadgeElement(tagEl)) {
        pluginTagEls.push(tagEl);
      } else {
        nativeTagEls.push(tagEl);
      }
    }

    // If Obsidian (or another native handler) already rendered a non-plugin `.nav-file-tag`,
    // never duplicate it; remove any leftover plugin badge if present.
    if (nativeTagEls.length > 0) {
      for (const extra of pluginTagEls) {
        extra.remove();
      }
      return;
    }

    if (!isEnabledSupportedType || !config) {
      for (const pluginBadge of pluginTagEls) {
        pluginBadge.remove();
      }
      return;
    }

    const desiredLabel = config.badgeLabel;
    const desiredExt = config.extension;

    if (pluginTagEls.length > 0) {
      const primaryBadge = pluginTagEls[0];
      for (let i = 1; i < pluginTagEls.length; i++) {
        pluginTagEls[i].remove();
      }
      setClassIfChanged(primaryBadge, "nav-file-tag", true);
      setClassIfChanged(primaryBadge, "file-support-badge", true);
      setAttrIfChanged(primaryBadge, "data-file-support-badge", "true");
      setAttrIfChanged(primaryBadge, "data-extension", desiredExt);
      if (primaryBadge.textContent !== desiredLabel) {
        primaryBadge.textContent = desiredLabel;
      }
      return;
    }

    const doc = titleEl.ownerDocument ?? document;
    const badgeEl = doc.createElement("div");
    badgeEl.className = "nav-file-tag file-support-badge";
    badgeEl.setAttribute("data-file-support-badge", "true");
    badgeEl.setAttribute("data-extension", desiredExt);
    badgeEl.textContent = desiredLabel;
    titleEl.appendChild(badgeEl);
  }

  /**
   * Idempotently synchronize `.is-companion-hidden` on verified companion `.md` items
   * and `.has-companion-metadata` underline + tooltip indicator on paired target items.
   */
  private syncItemCompanionDecoration(
    item: FileTreeItemNode,
    extension: string
  ): void {
    const { normalizedPath, titleEl, navFileEl } = item;

    if (!this.pairResolver.isMetadataEnabled()) {
      this.clearCompanionClasses(titleEl, navFileEl);
      return;
    }

    if (extension === "md") {
      this.clearTargetUnderline(titleEl, navFileEl);

      const mdFile = this.pairResolver.getTFileByPath(normalizedPath);
      const pairedTarget = mdFile
        ? this.pairResolver.resolveTargetForCompanion(mdFile)
        : null;

      if (pairedTarget) {
        setClassIfChanged(navFileEl, "is-companion-hidden", true);
        setClassIfChanged(titleEl, "is-companion-hidden", true);
        setAttrIfChanged(navFileEl, "data-companion-for", pairedTarget.path);
        setAttrIfChanged(titleEl, "data-companion-for", pairedTarget.path);
      } else {
        this.clearCompanionHidden(titleEl, navFileEl);
      }
      return;
    }

    // Non-Markdown file: never hidden as a companion note
    this.clearCompanionHidden(titleEl, navFileEl);

    const targetFile = this.pairResolver.getTFileByPath(normalizedPath);
    const pair = targetFile ? this.pairResolver.resolve(targetFile) : null;

    if (targetFile && pair?.companionFile) {
      const companion = pair.companionFile;
      const tooltipText = `${targetFile.name} — Companion metadata: ${companion.name} (Alt+Click to open)`;

      setClassIfChanged(titleEl, "has-companion-metadata", true);
      setClassIfChanged(navFileEl, "has-companion-metadata", true);
      setAttrIfChanged(titleEl, "data-companion-path", companion.path);
      setAttrIfChanged(navFileEl, "data-companion-path", companion.path);
      setAttrIfChanged(titleEl, "data-companion-tooltip", tooltipText);

      const hasUnmanagedAriaLabel =
        titleEl.getAttribute("aria-label") !== null &&
        titleEl.getAttribute("data-file-support-tooltip-managed") !== "true";
      if (!hasUnmanagedAriaLabel) {
        setAttrIfChanged(titleEl, "data-file-support-tooltip-managed", "true");
        setAttrIfChanged(titleEl, "aria-label", tooltipText);
      }
    } else {
      this.clearTargetUnderline(titleEl, navFileEl);
    }
  }

  private clearCompanionHidden(
    titleEl: HTMLElement,
    navFileEl: HTMLElement
  ): void {
    setClassIfChanged(navFileEl, "is-companion-hidden", false);
    setClassIfChanged(titleEl, "is-companion-hidden", false);
    removeAttrIfPresent(navFileEl, "data-companion-for");
    removeAttrIfPresent(titleEl, "data-companion-for");
  }

  private clearTargetUnderline(
    titleEl: HTMLElement,
    navFileEl: HTMLElement
  ): void {
    setClassIfChanged(titleEl, "has-companion-metadata", false);
    setClassIfChanged(navFileEl, "has-companion-metadata", false);
    removeAttrIfPresent(titleEl, "data-companion-path");
    removeAttrIfPresent(navFileEl, "data-companion-path");
    removeAttrIfPresent(titleEl, "data-companion-tooltip");
    if (
      titleEl.getAttribute?.("data-file-support-tooltip-managed") === "true"
    ) {
      removeAttrIfPresent(titleEl, "aria-label");
      removeAttrIfPresent(titleEl, "data-file-support-tooltip-managed");
    }
  }

  private clearCompanionClasses(
    titleEl: HTMLElement,
    navFileEl: HTMLElement
  ): void {
    this.clearCompanionHidden(titleEl, navFileEl);
    this.clearTargetUnderline(titleEl, navFileEl);
  }

  private cleanContainerDecorations(containerEl: HTMLElement): void {
    if (!containerEl || typeof containerEl.querySelectorAll !== "function") {
      return;
    }
    const badges = containerEl.querySelectorAll(
      '[data-file-support-badge="true"], .nav-file-tag.file-support-badge'
    );
    for (const badge of Array.from(badges)) {
      badge.remove();
    }

    const items = collectFileTreeItems(containerEl);
    for (const item of items) {
      this.clearCompanionClasses(item.titleEl, item.navFileEl);
    }
  }

  private ensureCaptureClickListener(containerEl: HTMLElement): void {
    if (
      !containerEl ||
      typeof containerEl.addEventListener !== "function" ||
      this.clickHandlersByContainer.has(containerEl)
    ) {
      return;
    }

    const handler = (evt: MouseEvent) => {
      this.handleContainerCaptureClick(containerEl, evt);
    };

    containerEl.addEventListener("click", handler, true);
    this.clickHandlersByContainer.set(containerEl, handler);
  }

  /**
   * Capture-phase click listener on decorated File Explorer containers.
   * Normal click passes through to Obsidian so the target file opens normally.
   * Modifier-click (`Alt+Click` or `Ctrl+Shift+Click` / `Meta+Shift+Click`) on an
   * eligible target file intercepts the click and dispatches `metadata:open-or-create`.
   */
  private handleContainerCaptureClick(
    containerEl: HTMLElement,
    evt: MouseEvent
  ): void {
    if (!evt || this.handledClickEvents.has(evt)) {
      return;
    }

    // Only intercept primary button clicks (button === 0 or undefined in synthetic events)
    if (typeof evt.button === "number" && evt.button !== 0) {
      return;
    }

    const isModifierClick = Boolean(
      evt.altKey || (evt.ctrlKey && evt.shiftKey) || (evt.metaKey && evt.shiftKey)
    );
    if (!isModifierClick) {
      return;
    }

    if (!this.pairResolver.isMetadataEnabled()) {
      return;
    }

    const filePath = this.resolveClickedFilePath(evt.target, containerEl);
    if (!filePath) {
      return;
    }

    const targetFile = this.pairResolver.getTFileByPath(filePath);
    if (!targetFile || !this.pairResolver.isTargetEligible(targetFile)) {
      return;
    }

    this.handledClickEvents.add(evt);
    evt.preventDefault?.();
    evt.stopPropagation?.();
    evt.stopImmediatePropagation?.();

    if (!this.eventBus) {
      return;
    }

    void this.eventBus
      .emit("metadata:open-or-create", {
        app: this.app,
        targetFile,
        openInNewLeaf: false,
      })
      .then(() => {
        if (!this.isContainerDetachedFromDocument(containerEl)) {
          this.decorateContainer(containerEl);
        }
      })
      .catch((err) => {
        console.warn(
          `[FileSupport] Failed to open or create companion note on modifier-click for "${targetFile.path}":`,
          err
        );
      });
  }

  private resolveClickedFilePath(
    eventTarget: EventTarget | null,
    containerEl: HTMLElement
  ): string | null {
    if (!eventTarget || typeof eventTarget !== "object") {
      return null;
    }

    const rawNode = eventTarget as Node;
    const startEl: HTMLElement | null = isElementNode(rawNode)
      ? rawNode
      : rawNode.parentElement ?? null;
    if (!startEl) {
      return null;
    }

    if (
      typeof containerEl.contains === "function" &&
      startEl !== containerEl &&
      !containerEl.contains(startEl)
    ) {
      return null;
    }

    // Never intercept clicks on folder headers
    if (
      typeof startEl.closest === "function" &&
      startEl.closest(".nav-folder-title")
    ) {
      return null;
    }

    if (typeof startEl.closest === "function") {
      const titleWithPath = startEl.closest(
        ".nav-file-title[data-path]"
      ) as HTMLElement | null;
      if (titleWithPath) {
        return titleWithPath.getAttribute("data-path");
      }

      const fileWithPath = startEl.closest(
        ".nav-file[data-path]"
      ) as HTMLElement | null;
      if (fileWithPath) {
        return fileWithPath.getAttribute("data-path");
      }

      const navFileEl = startEl.closest(".nav-file") as HTMLElement | null;
      if (navFileEl && typeof navFileEl.querySelector === "function") {
        const innerTitle = navFileEl.querySelector(
          ".nav-file-title[data-path], [data-path]"
        ) as HTMLElement | null;
        if (innerTitle) {
          return innerTitle.getAttribute("data-path");
        }
      }
    }

    return startEl.getAttribute?.("data-path") ?? null;
  }

  private handleMutations(
    containerEl: HTMLElement,
    records: MutationRecord[]
  ): void {
    if (this.isDecorating) {
      return;
    }
    if (this.isContainerDetachedFromDocument(containerEl)) {
      this.unobserveContainer(containerEl);
      this.decoratedContainers.delete(containerEl);
      return;
    }
    if (!this.isRelevantMutationBatch(containerEl, records)) {
      return;
    }

    void this.emitTreeDecorate(containerEl);
  }

  /**
   * Filter MutationObserver records to ignore self-generated badge mutations
   * and mutations referencing only already-detached added nodes.
   */
  private isRelevantMutationBatch(
    containerEl: HTMLElement,
    records: MutationRecord[]
  ): boolean {
    if (!Array.isArray(records) || records.length === 0) {
      return false;
    }

    const addedInThisBatch = new Set<Node>();
    for (const record of records) {
      if (record.type === "childList" && record.addedNodes) {
        for (const added of Array.from(record.addedNodes)) {
          addedInThisBatch.add(added);
        }
      }
    }

    const wasAddedInThisBatch = (node: Node): boolean => {
      let curr: Node | null = node;
      while (curr) {
        if (addedInThisBatch.has(curr)) {
          return true;
        }
        curr = curr.parentNode;
      }
      return false;
    };

    for (const record of records) {
      if (record.type === "attributes") {
        const target = record.target;
        if (
          isElementNode(target) &&
          !isPluginBadgeOrDescendant(target) &&
          this.isNodeConnectedToContainer(target, containerEl)
        ) {
          return true;
        }
        continue;
      }

      if (record.type === "childList") {
        // Check added nodes that are NOT our own badge and are still attached to containerEl
        const addedNodes = Array.from(record.addedNodes ?? []);
        for (const added of addedNodes) {
          if (isPluginBadgeOrDescendant(added)) {
            continue;
          }
          if (!this.isNodeConnectedToContainer(added, containerEl)) {
            continue;
          }
          if (this.doesNodeContainFileTreeStructure(added)) {
            return true;
          }
        }

        // Check removed nodes that are NOT our own badge and were not transiently added in the same batch
        const removedNodes = Array.from(record.removedNodes ?? []);
        for (const removed of removedNodes) {
          if (
            isPluginBadgeOrDescendant(removed) ||
            wasAddedInThisBatch(removed)
          ) {
            continue;
          }
          // Only relevant if the parent target where removal happened is still connected to containerEl
          if (
            record.target &&
            this.isNodeConnectedToContainer(record.target, containerEl) &&
            this.doesNodeContainFileTreeStructure(removed)
          ) {
            return true;
          }
        }
      }
    }

    return false;
  }

  private doesNodeContainFileTreeStructure(node: Node): boolean {
    if (!isElementNode(node)) {
      return false;
    }
    if (
      node.classList?.contains("nav-file") ||
      node.classList?.contains("nav-file-title") ||
      node.classList?.contains("nav-folder") ||
      node.classList?.contains("nav-folder-children") ||
      node.classList?.contains("tree-item") ||
      node.classList?.contains("tree-item-children") ||
      node.getAttribute?.("data-path") !== null
    ) {
      return true;
    }
    if (typeof node.querySelector === "function") {
      return Boolean(
        node.querySelector(".nav-file, .nav-file-title, [data-path]")
      );
    }
    return false;
  }

  private buildExpandedPathFilter(
    filePaths?: string[]
  ): { exactPaths: Set<string>; dirBasenames: Set<string> } | undefined {
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      return undefined;
    }
    const exactPaths = new Set<string>();
    const dirBasenames = new Set<string>();

    for (const rawPath of filePaths) {
      if (!rawPath || typeof rawPath !== "string") {
        continue;
      }
      const norm = normalizePath(rawPath);
      exactPaths.add(norm);

      const parts = splitFilePath(norm);
      const dirPrefix = parts.dir ? `${parts.dir}/` : "";
      dirBasenames.add(`${dirPrefix}${parts.basename}`);

      if (parts.extension === "md") {
        const mdFile = this.pairResolver.getTFileByPath(norm);
        const target = mdFile
          ? this.pairResolver.resolveTargetForCompanion(mdFile)
          : null;
        if (target) {
          exactPaths.add(normalizePath(target.path));
        }
        if (parts.basename.includes(".")) {
          const siblingPath = `${dirPrefix}${parts.basename}`;
          exactPaths.add(normalizePath(siblingPath));
          const siblingParts = splitFilePath(siblingPath);
          dirBasenames.add(`${dirPrefix}${siblingParts.basename}`);
        }
      } else if (parts.extension) {
        exactPaths.add(
          normalizePath(this.pairResolver.getPrimaryCompanionPath(norm))
        );
        exactPaths.add(
          normalizePath(this.pairResolver.getFallbackCompanionPath(norm))
        );
      }
    }
    return { exactPaths, dirBasenames };
  }

  private doesItemMatchFilter(
    item: FileTreeItemNode,
    filter: { exactPaths: Set<string>; dirBasenames: Set<string> }
  ): boolean {
    if (filter.exactPaths.has(item.normalizedPath)) {
      return true;
    }
    const companionPath = item.titleEl.getAttribute?.("data-companion-path");
    if (companionPath && filter.exactPaths.has(normalizePath(companionPath))) {
      return true;
    }
    const companionFor = item.titleEl.getAttribute?.("data-companion-for");
    if (companionFor && filter.exactPaths.has(normalizePath(companionFor))) {
      return true;
    }
    const parts = splitFilePath(item.normalizedPath);
    const dirPrefix = parts.dir ? `${parts.dir}/` : "";
    if (
      filter.dirBasenames.has(`${dirPrefix}${parts.basename}`) ||
      filter.dirBasenames.has(`${dirPrefix}${parts.name}`)
    ) {
      return true;
    }
    return false;
  }

  private async emitTreeDecorate(
    containerEl: HTMLElement,
    filePaths?: string[]
  ): Promise<void> {
    if (!this.eventBus) {
      this.decorateContainer(containerEl, filePaths);
      return;
    }
    await this.eventBus.emit("tree:decorate", {
      app: this.app,
      containerEl,
      filePaths,
    });
  }

  private discoverFileExplorerContainers(): HTMLElement[] {
    const found: HTMLElement[] = [];
    const seen = new Set<HTMLElement>();

    const addContainer = (el: unknown) => {
      if (!isElementNode(el) || seen.has(el)) {
        return;
      }
      if (this.isContainerDetachedFromDocument(el)) {
        return;
      }
      seen.add(el);
      found.push(el);
    };

    const leaves = this.app?.workspace?.getLeavesOfType?.("file-explorer");
    if (Array.isArray(leaves)) {
      for (const leaf of leaves) {
        const viewRoot: HTMLElement | undefined =
          (leaf?.view as any)?.containerEl ?? (leaf?.view as any)?.contentEl;
        if (!isElementNode(viewRoot)) {
          continue;
        }
        if (viewRoot.classList?.contains("nav-files-container")) {
          addContainer(viewRoot);
          continue;
        }
        if (typeof viewRoot.querySelectorAll === "function") {
          const innerContainers = viewRoot.querySelectorAll(
            ".nav-files-container"
          );
          if (innerContainers.length > 0) {
            for (const c of Array.from(innerContainers)) {
              addContainer(c);
            }
            continue;
          }
        }
        addContainer(viewRoot);
      }
    }

    if (
      typeof document !== "undefined" &&
      typeof document.querySelectorAll === "function"
    ) {
      const domContainers = document.querySelectorAll(".nav-files-container");
      for (const c of Array.from(domContainers)) {
        addContainer(c);
      }
    }

    return found;
  }

  private pruneDetachedContainers(): void {
    for (const container of Array.from(this.observersByContainer.keys())) {
      if (this.isContainerDetachedFromDocument(container)) {
        this.unobserveContainer(container);
        this.decoratedContainers.delete(container);
      }
    }
  }

  private drainObserverRecords(): void {
    for (const observer of this.observersByContainer.values()) {
      try {
        observer.takeRecords();
      } catch {
        // Ignore takeRecords errors
      }
    }
  }

  private isContainerDetachedFromDocument(containerEl: HTMLElement): boolean {
    if (typeof containerEl.isConnected === "boolean") {
      return !containerEl.isConnected;
    }
    if (typeof document !== "undefined" && document.body) {
      return !document.body.contains(containerEl);
    }
    return false;
  }

  private isNodeConnectedToContainer(
    node: Node,
    containerEl: HTMLElement
  ): boolean {
    if (node === containerEl) {
      return true;
    }
    if (
      typeof containerEl.isConnected === "boolean" &&
      containerEl.isConnected &&
      typeof (node as Node).isConnected === "boolean" &&
      !(node as Node).isConnected
    ) {
      return false;
    }
    if (typeof containerEl.contains === "function") {
      return containerEl.contains(node);
    }
    return true;
  }

  private isItemConnectedToContainer(
    item: FileTreeItemNode,
    containerEl: HTMLElement
  ): boolean {
    return this.isNodeConnectedToContainer(item.titleEl, containerEl);
  }

  private registerWorkspaceListeners(): void {
    const workspace = this.app?.workspace as any;
    if (!workspace) {
      return;
    }

    if (typeof workspace.onLayoutReady === "function") {
      workspace.onLayoutReady(() => {
        this.scanAndObserveFileExplorers();
      });
    }

    if (typeof workspace.on !== "function") {
      return;
    }

    const onLayoutChange = () => {
      this.scanAndObserveFileExplorers();
    };
    const layoutRef = workspace.on("layout-change", onLayoutChange);
    if (layoutRef) {
      this.workspaceEventRefs.push({
        name: "layout-change",
        ref: layoutRef,
        fn: onLayoutChange,
      });
    }

    const onFileMenu = (
      menu: Menu,
      file: TAbstractFile,
      source: string,
      leaf?: WorkspaceLeaf
    ) => {
      this.handleFileMenu(menu, file, source, leaf);
    };
    const fileMenuRef = workspace.on("file-menu", onFileMenu);
    if (fileMenuRef) {
      this.workspaceEventRefs.push({
        name: "file-menu",
        ref: fileMenuRef,
        fn: onFileMenu,
      });
    }
  }

  private registerVaultAndCacheListeners(): void {
    const vault = this.app?.vault as any;
    if (vault && typeof vault.on === "function") {
      const onVaultChange = (file: TAbstractFile, oldPath?: string) => {
        const paths: string[] = [];
        if (file && typeof file.path === "string") {
          paths.push(file.path);
        }
        if (typeof oldPath === "string" && oldPath) {
          paths.push(oldPath);
        }
        void this.refreshAllFileExplorers(paths.length > 0 ? paths : undefined);
      };

      for (const evtName of ["create", "rename", "delete"] as const) {
        const ref = vault.on(evtName, onVaultChange);
        if (ref) {
          this.vaultEventRefs.push({
            name: evtName,
            ref,
            fn: onVaultChange,
          });
        }
      }
    }

    const metadataCache = this.app?.metadataCache as any;
    if (metadataCache && typeof metadataCache.on === "function") {
      const onCacheChanged = (file?: TAbstractFile) => {
        const paths =
          file && typeof file.path === "string" ? [file.path] : undefined;
        void this.refreshAllFileExplorers(paths);
      };

      for (const evtName of ["changed", "deleted", "resolved"] as const) {
        const ref = metadataCache.on(evtName, onCacheChanged);
        if (ref) {
          this.metadataCacheEventRefs.push({
            name: evtName,
            ref,
            fn: onCacheChanged,
          });
        }
      }
    }
  }

  private cleanupSubscriptions(): void {
    for (const unsub of this.unsubscribers.splice(0)) {
      try {
        unsub();
      } catch {
        // Ignore unsubscribe errors
      }
    }

    const workspace = this.app?.workspace as any;
    for (const entry of this.workspaceEventRefs.splice(0)) {
      try {
        if (typeof workspace?.offref === "function") {
          workspace.offref(entry.ref);
        } else if (typeof workspace?.off === "function") {
          workspace.off(entry.name, entry.fn);
        }
      } catch {
        // Ignore workspace cleanup errors
      }
    }

    const vault = this.app?.vault as any;
    for (const entry of this.vaultEventRefs.splice(0)) {
      try {
        if (typeof vault?.offref === "function") {
          vault.offref(entry.ref);
        } else if (typeof vault?.off === "function") {
          vault.off(entry.name, entry.fn);
        }
      } catch {
        // Ignore vault cleanup errors
      }
    }

    const metadataCache = this.app?.metadataCache as any;
    for (const entry of this.metadataCacheEventRefs.splice(0)) {
      try {
        if (typeof metadataCache?.offref === "function") {
          metadataCache.offref(entry.ref);
        } else if (typeof metadataCache?.off === "function") {
          metadataCache.off(entry.name, entry.fn);
        }
      } catch {
        // Ignore metadataCache cleanup errors
      }
    }
  }
}
