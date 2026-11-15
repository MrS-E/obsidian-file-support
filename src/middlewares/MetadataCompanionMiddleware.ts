import {
  App,
  type EventRef,
  Notice,
  TAbstractFile,
  TFile,
  normalizePath,
} from "obsidian";
import type { EventBus, NextFn, UnsubscribeFn } from "../core/EventBus";
import { normalizeExtension } from "../core/FileTypeRegistry";
import {
  LazyPairResolver,
  getParentDirPath,
  syncFileObjectPath,
} from "../metadata/LazyPairResolver";
import type {
  CompanionPair,
  ConfigUpdatedEventPayload,
  MetadataOpenOrCreateEventPayload,
  MetadataResolveEventPayload,
} from "../types/contracts";

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
 * Middleware managing companion `.md` metadata note resolution (`metadata:resolve`),
 * on-demand creation and navigation (`metadata:open-or-create`), and Vault
 * `rename` / `delete` synchronization.
 */
export class MetadataCompanionMiddleware {
  readonly id = "metadata-companion";
  private app: App;
  private resolver: LazyPairResolver;
  private eventBus: EventBus | null = null;
  private unsubscribers: UnsubscribeFn[] = [];
  private vaultEventRefs: Array<{ name: string; ref: EventRef; fn: (...args: any[]) => any }> = [];
  private inFlightCompanionPaths: Set<string> = new Set();
  private knownCompanionByTargetPath: Map<string, TFile> = new Map();

  constructor(app: App, resolver: LazyPairResolver) {
    this.app = app;
    this.resolver = resolver;
  }

  setApp(app: App): void {
    this.app = app;
    this.resolver.setApp(app);
  }

  getResolver(): LazyPairResolver {
    return this.resolver;
  }

  /**
   * Register `metadata:resolve`, `metadata:open-or-create`, `config:updated` middlewares/listeners
   * on the `EventBus` and subscribe to Vault `rename` and `delete` events.
   */
  register(eventBus: EventBus): UnsubscribeFn {
    this.cleanupSubscriptions();
    this.eventBus = eventBus;

    this.unsubscribers.push(
      eventBus.use("metadata:resolve", (payload, next) =>
        this.handleMetadataResolve(payload, next)
      )
    );

    this.unsubscribers.push(
      eventBus.use("metadata:open-or-create", (payload, next) =>
        this.handleMetadataOpenOrCreate(payload, next)
      )
    );

    this.unsubscribers.push(
      eventBus.on("config:updated", (payload) =>
        this.handleConfigUpdated(payload)
      )
    );

    this.registerVaultListeners();

    return () => {
      this.destroy();
    };
  }

  /**
   * Synchronously resolve a target file's companion pair and update internal tracking.
   */
  resolvePair(targetFile: TFile): CompanionPair | null {
    const pair = this.resolver.resolve(targetFile);
    const normTarget = normalizePath(targetFile.path);
    if (pair?.companionFile) {
      this.knownCompanionByTargetPath.set(normTarget, pair.companionFile);
    } else {
      this.knownCompanionByTargetPath.delete(normTarget);
    }
    return pair;
  }

  /**
   * Open an existing companion `.md` note or create it on demand with YAML frontmatter
   * (`file-support-target: "[[<filename>.<ext>]]"` and default tags), then open it in a leaf.
   */
  async openOrCreateCompanion(
    targetFile: TFile,
    openInNewLeaf: boolean = false,
    appOverride?: App
  ): Promise<TFile | null> {
    const activeApp = appOverride ?? this.app;
    if (!this.resolver.isMetadataEnabled()) {
      return null;
    }
    if (!this.resolver.isTargetEligible(targetFile)) {
      return null;
    }

    const pair = this.resolvePair(targetFile);
    if (!pair) {
      return null;
    }

    let companionFile = pair.companionFile;
    let createdNew = false;

    if (!companionFile) {
      const existingAtExpected = this.resolver.getTFileByPath(
        pair.expectedCompanionPath
      );
      if (existingAtExpected) {
        if (
          this.resolver.doesCompanionLinkToTarget(
            existingAtExpected,
            targetFile
          )
        ) {
          companionFile = existingAtExpected;
        } else {
          // Both `<basename>.md` and `<basename>.<ext>.md` are already occupied by unrelated notes.
          // Refuse to overwrite user notes destructively.
          new Notice(
            `Cannot create companion note for "${targetFile.name}": "${pair.expectedCompanionPath}" already exists and is not linked to this file.`
          );
          return null;
        }
      } else {
        const initialContent = this.resolver.buildInitialCompanionContent(
          targetFile,
          pair.expectedCompanionPath
        );
        const normExpected = normalizePath(pair.expectedCompanionPath);
        this.inFlightCompanionPaths.add(normExpected);
        try {
          companionFile = await activeApp.vault.create(
            pair.expectedCompanionPath,
            initialContent
          );
          createdNew = true;
        } finally {
          this.inFlightCompanionPaths.delete(normExpected);
        }
      }
    }

    if (!companionFile) {
      return null;
    }

    await this.resolver.writeCompanionFrontmatter(companionFile, targetFile);
    this.knownCompanionByTargetPath.set(
      normalizePath(targetFile.path),
      companionFile
    );

    if (
      createdNew &&
      this.resolver.getSettingsSnapshot()?.autoRunExtractorOnCreate &&
      this.eventBus
    ) {
      await this.eventBus.emit("metadata:extract", {
        app: activeApp,
        targetFile,
        companionFile,
        config: this.resolver.getFileTypeConfig(targetFile),
      });
    }

    const leaf = activeApp?.workspace?.getLeaf?.(openInNewLeaf);
    if (leaf && typeof (leaf as any).openFile === "function") {
      await (leaf as any).openFile(companionFile);
    }

    return companionFile;
  }

  /**
   * Handle Vault `rename` events to keep target files and their companion `.md` notes
   * (both filename and YAML `file-support-target` link) synchronized.
   */
  async handleVaultRename(
    file: TAbstractFile,
    oldPath: string
  ): Promise<void> {
    if (!file || !oldPath || !isTFileLike(file)) {
      return;
    }

    const normOld = normalizePath(oldPath);
    const normNew = normalizePath(file.path);
    if (normOld === normNew) {
      return;
    }

    if (
      this.inFlightCompanionPaths.has(normOld) ||
      this.inFlightCompanionPaths.has(normNew)
    ) {
      return;
    }

    if (normalizeExtension(file.extension) === "md") {
      this.resolver.handlePathRename(normOld, normNew);
      return;
    }

    const cachedCompanion = this.knownCompanionByTargetPath.get(normOld);
    this.knownCompanionByTargetPath.delete(normOld);

    if (!this.resolver.isMetadataEnabled()) {
      return;
    }

    const wasOldEligible = this.resolver.isTargetPathEligible(normOld);
    const isNewEligible = this.resolver.isTargetEligible(file);
    if (!wasOldEligible && !isNewEligible && !cachedCompanion) {
      return;
    }

    // Locate the companion note from the old path even though `oldPath` is no longer in the vault
    let companionFile = this.resolver.resolveExistingCompanionForPath(
      normOld,
      normNew
    );

    if (!companionFile && cachedCompanion) {
      const stillInVault =
        this.resolver.getTFileByPath(cachedCompanion.path) ?? cachedCompanion;
      if (
        this.resolver.doesCompanionLinkToTarget(stillInVault, normOld) ||
        this.resolver.doesCompanionLinkToTarget(stillInVault, normNew)
      ) {
        companionFile = stillInVault;
      }
    }

    if (!companionFile) {
      return;
    }

    let effectiveCompanionDir = getParentDirPath(companionFile.path);

    if (isNewEligible) {
      const { expectedCompanionPath } =
        this.resolver.resolveDesiredCompanionPathForTarget(file, companionFile);
      const normCurrentCompanion = normalizePath(companionFile.path);
      const normDesiredCompanion = normalizePath(expectedCompanionPath);

      if (normCurrentCompanion !== normDesiredCompanion) {
        const existingAtDest =
          this.resolver.getTFileByPath(normDesiredCompanion);
        if (
          !existingAtDest ||
          normalizePath(existingAtDest.path) === normCurrentCompanion
        ) {
          this.inFlightCompanionPaths.add(normCurrentCompanion);
          this.inFlightCompanionPaths.add(normDesiredCompanion);
          try {
            await this.renameCompanionFile(companionFile, normDesiredCompanion);
            this.resolver.handlePathRename(
              normCurrentCompanion,
              normDesiredCompanion
            );
            effectiveCompanionDir = getParentDirPath(normDesiredCompanion);
          } finally {
            this.inFlightCompanionPaths.delete(normCurrentCompanion);
            this.inFlightCompanionPaths.delete(normDesiredCompanion);
          }
        }
      } else {
        effectiveCompanionDir = getParentDirPath(normDesiredCompanion);
      }

      this.knownCompanionByTargetPath.set(normNew, companionFile);
    } else {
      this.knownCompanionByTargetPath.set(normNew, companionFile);
    }

    // Always synchronize the YAML frontmatter `file-support-target` link to the renamed target
    await this.resolver.writeCompanionFrontmatter(
      companionFile,
      file,
      undefined,
      effectiveCompanionDir
    );
  }

  /**
   * Handle Vault `delete` events to invalidate resolver caches without destructively deleting user notes.
   */
  async handleVaultDelete(file: TAbstractFile): Promise<void> {
    if (!file || !isTFileLike(file)) {
      return;
    }
    const normDeleted = normalizePath(file.path);
    this.resolver.invalidatePath(normDeleted);

    if (normalizeExtension(file.extension) === "md") {
      for (const [targetPath, comp] of Array.from(
        this.knownCompanionByTargetPath.entries()
      )) {
        if (normalizePath(comp.path) === normDeleted) {
          this.knownCompanionByTargetPath.delete(targetPath);
        }
      }
    } else {
      this.knownCompanionByTargetPath.delete(normDeleted);
    }
  }

  destroy(): void {
    this.cleanupSubscriptions();
    this.inFlightCompanionPaths.clear();
    this.knownCompanionByTargetPath.clear();
    this.eventBus = null;
  }

  private handleMetadataResolve(
    payload: MetadataResolveEventPayload,
    next: NextFn
  ): Promise<void> | void {
    if (!payload?.targetFile) {
      payload.pair = null;
      return next();
    }
    payload.pair = this.resolvePair(payload.targetFile);
    return next();
  }

  private handleMetadataOpenOrCreate(
    payload: MetadataOpenOrCreateEventPayload,
    next: NextFn
  ): Promise<void> | void {
    if (
      !payload?.targetFile ||
      !this.resolver.isMetadataEnabled() ||
      !this.resolver.isTargetEligible(payload.targetFile)
    ) {
      if (payload) {
        payload.companionFile = null;
      }
      return next();
    }

    return (async () => {
      payload.companionFile = await this.openOrCreateCompanion(
        payload.targetFile,
        Boolean(payload.openInNewLeaf),
        payload.app ?? this.app
      );
      await next();
    })();
  }

  private handleConfigUpdated(payload: ConfigUpdatedEventPayload): void {
    if (payload?.settings) {
      this.resolver.updateSettings(payload.settings);
      if (!payload.settings.enableMetadataFiles) {
        this.knownCompanionByTargetPath.clear();
      }
    }
  }

  private registerVaultListeners(): void {
    const vault = this.app?.vault as any;
    if (!vault || typeof vault.on !== "function") {
      return;
    }

    const onRename = (file: TAbstractFile, oldPath: string) => {
      void this.handleVaultRename(file, oldPath);
    };
    const onDelete = (file: TAbstractFile) => {
      void this.handleVaultDelete(file);
    };

    const renameRef = vault.on("rename", onRename);
    if (renameRef) {
      this.vaultEventRefs.push({ name: "rename", ref: renameRef, fn: onRename });
    }

    const deleteRef = vault.on("delete", onDelete);
    if (deleteRef) {
      this.vaultEventRefs.push({ name: "delete", ref: deleteRef, fn: onDelete });
    }
  }

  private async renameCompanionFile(
    companionFile: TFile,
    newPath: string
  ): Promise<void> {
    if (typeof this.app?.fileManager?.renameFile === "function") {
      await this.app.fileManager.renameFile(companionFile, newPath);
    } else if (typeof this.app?.vault?.rename === "function") {
      await this.app.vault.rename(companionFile, newPath);
    }
    if (normalizePath(companionFile.path) !== normalizePath(newPath)) {
      syncFileObjectPath(companionFile, newPath);
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

    const vault = this.app?.vault as any;
    for (const entry of this.vaultEventRefs.splice(0)) {
      try {
        if (typeof vault?.offref === "function") {
          vault.offref(entry.ref);
        } else if (typeof vault?.off === "function") {
          vault.off(entry.name, entry.fn);
        }
      } catch {
        // Ignore vault listener cleanup errors
      }
    }
  }
}
