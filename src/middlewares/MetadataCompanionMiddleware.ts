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
  private inFlightCompanionPaths: Set<string> = new Set();
  private inFlightOpenOrCreateByTargetPath: Map<
    string,
    Promise<TFile | null>
  > = new Map();
  private inFlightCreateByCompanionPath: Map<string, Promise<TFile | null>> =
    new Map();
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
    this.registerMetadataCacheListeners();

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
   * Reopening an already-linked companion note is idempotent and does not rewrite YAML frontmatter.
   * Concurrent calls for the same target file share a single in-flight operation.
   */
  async openOrCreateCompanion(
    targetFile: TFile,
    openInNewLeaf: boolean = false,
    appOverride?: App
  ): Promise<TFile | null> {
    const activeApp = appOverride ?? this.app;
    if (!targetFile || !this.resolver.isMetadataEnabled()) {
      return null;
    }
    if (!this.resolver.isTargetEligible(targetFile)) {
      return null;
    }

    const normTarget = normalizePath(targetFile.path);
    const existingInFlight =
      this.inFlightOpenOrCreateByTargetPath.get(normTarget);
    if (existingInFlight) {
      return existingInFlight;
    }

    const operationPromise = this.performOpenOrCreateCompanion(
      targetFile,
      openInNewLeaf,
      activeApp
    );
    this.inFlightOpenOrCreateByTargetPath.set(normTarget, operationPromise);
    try {
      return await operationPromise;
    } finally {
      if (
        this.inFlightOpenOrCreateByTargetPath.get(normTarget) ===
        operationPromise
      ) {
        this.inFlightOpenOrCreateByTargetPath.delete(normTarget);
      }
    }
  }

  private async performOpenOrCreateCompanion(
    targetFile: TFile,
    openInNewLeaf: boolean,
    activeApp: App
  ): Promise<TFile | null> {
    try {
      const primaryCandidatePath = normalizePath(
        this.resolver.getPrimaryCompanionPath(targetFile)
      );
      const pendingPrimaryCreation =
        this.inFlightCreateByCompanionPath.get(primaryCandidatePath);
      if (pendingPrimaryCreation) {
        try {
          await pendingPrimaryCreation;
        } catch {
          // Ignore sibling creation error and re-resolve below
        }
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

          const createTask = (async (): Promise<TFile | null> => {
            const created = await activeApp.vault.create(
              pair.expectedCompanionPath,
              initialContent
            );
            await this.resolver.writeCompanionFrontmatter(
              created,
              targetFile,
              undefined,
              undefined,
              { includeDefaultTags: true }
            );
            return created;
          })();

          this.inFlightCreateByCompanionPath.set(normExpected, createTask);
          try {
            companionFile = await createTask;
            createdNew = true;
          } finally {
            this.inFlightCompanionPaths.delete(normExpected);
            if (
              this.inFlightCreateByCompanionPath.get(normExpected) ===
              createTask
            ) {
              this.inFlightCreateByCompanionPath.delete(normExpected);
            }
          }
        }
      }

      if (!companionFile) {
        return null;
      }

      // Only write frontmatter on an existing file if its target link is missing or out of date;
      // never rewrite YAML or re-merge default tags when reopening an already-linked companion note.
      if (
        !createdNew &&
        !this.resolver.doesCompanionLinkToTarget(companionFile, targetFile)
      ) {
        await this.resolver.writeCompanionFrontmatter(
          companionFile,
          targetFile,
          undefined,
          undefined,
          { includeDefaultTags: false }
        );
      }

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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[FileSupport] Failed to open or create companion note for "${targetFile?.path ?? ""}":`,
        err
      );
      new Notice(
        `Failed to open or create companion metadata note for "${targetFile?.name ?? "file"}": ${message}`
      );
      return null;
    }
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
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(
              `[FileSupport] Failed to rename companion metadata note "${normCurrentCompanion}" -> "${normDesiredCompanion}":`,
              err
            );
            new Notice(
              `Failed to rename companion metadata note "${companionFile.name}": ${message}`
            );
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

    // Synchronize the YAML frontmatter `file-support-target` link to the renamed target
    // without re-merging default tags into an existing companion note.
    try {
      await this.resolver.writeCompanionFrontmatter(
        companionFile,
        file,
        undefined,
        effectiveCompanionDir,
        { includeDefaultTags: false }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[FileSupport] Failed to update companion frontmatter for "${companionFile.path}":`,
        err
      );
      new Notice(
        `Failed to update frontmatter in companion note "${companionFile.name}": ${message}`
      );
    }
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
    this.inFlightOpenOrCreateByTargetPath.clear();
    this.inFlightCreateByCompanionPath.clear();
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
      try {
        payload.companionFile = await this.openOrCreateCompanion(
          payload.targetFile,
          Boolean(payload.openInNewLeaf),
          payload.app ?? this.app
        );
      } catch (err) {
        console.warn(
          "[FileSupport] Unhandled error in metadata:open-or-create middleware:",
          err
        );
        payload.companionFile = null;
      }
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
      void this.handleVaultRename(file, oldPath).catch((err) => {
        console.warn("[FileSupport] Error handling vault rename:", err);
      });
    };
    const onDelete = (file: TAbstractFile) => {
      void this.handleVaultDelete(file).catch((err) => {
        console.warn("[FileSupport] Error handling vault delete:", err);
      });
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

  private registerMetadataCacheListeners(): void {
    const metadataCache = this.app?.metadataCache as any;
    if (!metadataCache || typeof metadataCache.on !== "function") {
      return;
    }

    const onChanged = (file: TAbstractFile) => {
      if (file && typeof file.path === "string") {
        this.resolver.invalidatePath(file.path);
      }
    };
    const onDeleted = (file: TAbstractFile) => {
      if (file && typeof file.path === "string") {
        this.resolver.invalidatePath(file.path);
      }
    };

    const changedRef = metadataCache.on("changed", onChanged);
    if (changedRef) {
      this.metadataCacheEventRefs.push({
        name: "changed",
        ref: changedRef,
        fn: onChanged,
      });
    }

    const deletedRef = metadataCache.on("deleted", onDeleted);
    if (deletedRef) {
      this.metadataCacheEventRefs.push({
        name: "deleted",
        ref: deletedRef,
        fn: onDeleted,
      });
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

    const metadataCache = this.app?.metadataCache as any;
    for (const entry of this.metadataCacheEventRefs.splice(0)) {
      try {
        if (typeof metadataCache?.offref === "function") {
          metadataCache.offref(entry.ref);
        } else if (typeof metadataCache?.off === "function") {
          metadataCache.off(entry.name, entry.fn);
        }
      } catch {
        // Ignore metadataCache listener cleanup errors
      }
    }
  }
}
