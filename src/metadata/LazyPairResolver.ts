import { App, TFile, normalizePath } from "obsidian";
import {
  FileTypeRegistry,
  normalizeExtension,
} from "../core/FileTypeRegistry";
import { validateDirectoryRegex } from "../settings/PluginSettings";
import type {
  CompanionPair,
  FileTypeConfig,
  PluginSettings,
} from "../types/contracts";

export interface SplitPathParts {
  path: string;
  dir: string;
  name: string;
  basename: string;
  extension: string;
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
 * Split any vault-relative file path into directory, filename, basename, and lowercase extension.
 * Works on both existing files and historical `oldPath` strings after renames/deletes.
 */
export function splitFilePath(rawPath: string): SplitPathParts {
  const normalized = normalizePath(rawPath ?? "");
  const slashIdx = normalized.lastIndexOf("/");
  const dir = slashIdx > 0 ? normalized.slice(0, slashIdx) : "";
  const name = slashIdx !== -1 ? normalized.slice(slashIdx + 1) : normalized;
  const dotIdx = name.lastIndexOf(".");
  if (dotIdx > 0) {
    return {
      path: normalized,
      dir,
      name,
      basename: name.slice(0, dotIdx),
      extension: normalizeExtension(name.slice(dotIdx + 1)),
    };
  }
  return {
    path: normalized,
    dir,
    name,
    basename: name,
    extension: "",
  };
}

/**
 * Return the normalized parent directory path for a TFile or path string.
 * Returns `""` for vault root files.
 */
export function getParentDirPath(fileOrPath: TFile | string): string {
  const rawPath =
    typeof fileOrPath === "string" ? fileOrPath : (fileOrPath?.path ?? "");
  return splitFilePath(rawPath).dir;
}

/**
 * Format a YAML frontmatter wiki-link targeting `targetFileOrPath`.
 * Uses `"[[<filename>.<ext>]]"` when the companion note is in the same directory
 * as the target file, or `"[[<vault-path>]]"` if in a different directory.
 */
export function formatTargetWikiLink(
  targetFileOrPath: TFile | string,
  companionDirPath?: string
): string {
  const rawPath =
    typeof targetFileOrPath === "string"
      ? targetFileOrPath
      : targetFileOrPath.path;
  const targetParts = splitFilePath(rawPath);
  const normalizedCompanionDir =
    companionDirPath !== undefined ? normalizePath(companionDirPath) : undefined;

  if (
    normalizedCompanionDir === undefined ||
    normalizedCompanionDir === targetParts.dir
  ) {
    return `[[${targetParts.name}]]`;
  }
  return `[[${targetParts.path}]]`;
}

/**
 * Extract the link target path/filename from a raw YAML frontmatter property value.
 * Handles:
 * - `"[[filename.ext]]"` / `"![[filename.ext]]"`
 * - `"[[folder/filename.ext|Alias]]"` / `"[[filename.ext#subpath]]"`
 * - plain unbracketed `"filename.ext"`
 * - unquoted YAML `[[filename.ext]]` parsed as nested arrays `[["filename.ext"]]`
 */
export function extractWikiLinkTarget(rawValue: unknown): string | null {
  if (rawValue === null || rawValue === undefined) {
    return null;
  }

  if (Array.isArray(rawValue)) {
    if (rawValue.length !== 1) {
      return null;
    }
    const first = rawValue[0];
    if (Array.isArray(first)) {
      if (first.length === 1 && typeof first[0] === "string") {
        return extractWikiLinkTarget(`[[${first[0]}]]`);
      }
      return null;
    }
    if (typeof first === "string") {
      return extractWikiLinkTarget(first);
    }
    return null;
  }

  if (typeof rawValue !== "string") {
    return null;
  }

  let cleaned = rawValue.trim();
  if (!cleaned) {
    return null;
  }

  // Strip surrounding single or double quotes if present
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  if (cleaned.startsWith("![[") && cleaned.endsWith("]]")) {
    cleaned = cleaned.slice(3, -2).trim();
  } else if (cleaned.startsWith("[[") && cleaned.endsWith("]]")) {
    cleaned = cleaned.slice(2, -2).trim();
  }

  if (!cleaned) {
    return null;
  }

  const pipeIdx = cleaned.indexOf("|");
  if (pipeIdx !== -1) {
    cleaned = cleaned.slice(0, pipeIdx).trim();
  }

  const hashIdx = cleaned.indexOf("#");
  if (hashIdx !== -1) {
    cleaned = cleaned.slice(0, hashIdx).trim();
  }

  cleaned = cleaned.replace(/^\.\//, "").trim();
  if (!cleaned) {
    return null;
  }

  return cleaned;
}

/**
 * Determine whether a raw frontmatter property value links to `targetFileOrPath`.
 */
export function doesFrontmatterLinkMatchTarget(
  rawValue: unknown,
  targetFileOrPath: TFile | string,
  companionDirPath?: string,
  app?: App
): boolean {
  const linkTarget = extractWikiLinkTarget(rawValue);
  if (!linkTarget) {
    return false;
  }

  const rawTargetPath =
    typeof targetFileOrPath === "string"
      ? targetFileOrPath
      : targetFileOrPath.path;
  const targetParts = splitFilePath(rawTargetPath);
  const normalizedCompanionDir =
    companionDirPath !== undefined
      ? normalizePath(companionDirPath)
      : targetParts.dir;

  if (!linkTarget.includes("/")) {
    if (
      linkTarget === targetParts.name &&
      normalizedCompanionDir === targetParts.dir
    ) {
      return true;
    }
    if (linkTarget === targetParts.path && targetParts.dir === "") {
      return true;
    }
  } else {
    const normalizedLink = normalizePath(linkTarget);
    if (normalizedLink === targetParts.path) {
      return true;
    }
    if (normalizedCompanionDir) {
      const relativeResolved = normalizePath(
        `${normalizedCompanionDir}/${normalizedLink}`
      );
      if (relativeResolved === targetParts.path) {
        return true;
      }
    }
  }

  if (app?.metadataCache?.getFirstLinkpathDest) {
    const sourcePath = normalizedCompanionDir
      ? `${normalizedCompanionDir}/__companion__.md`
      : "__companion__.md";
    const resolvedDest = app.metadataCache.getFirstLinkpathDest(
      linkTarget,
      sourcePath
    );
    if (resolvedDest && normalizePath(resolvedDest.path) === targetParts.path) {
      return true;
    }
  }

  return false;
}

/**
 * Normalize a single tag string by trimming whitespace and stripping any leading `#`.
 */
export function normalizeMetadataTag(tag: string): string {
  return tag.trim().replace(/^#+/, "").trim();
}

/**
 * Non-destructively merge default metadata tags with any existing YAML frontmatter tags.
 * Preserves existing user tags and avoids adding duplicate tags (with or without leading `#`).
 */
export function mergeFrontmatterTags(
  existingTags: unknown,
  defaultTags: string[]
): string[] {
  const result: string[] = [];
  const seenNormalized = new Set<string>();

  const addTag = (raw: string, normalizeOutput: boolean = false) => {
    const trimmed = raw.trim();
    const norm = normalizeMetadataTag(trimmed);
    if (!norm) {
      return;
    }
    const lowerKey = norm.toLowerCase();
    if (seenNormalized.has(lowerKey)) {
      return;
    }
    seenNormalized.add(lowerKey);
    result.push(normalizeOutput ? norm : trimmed);
  };

  if (Array.isArray(existingTags)) {
    for (const item of existingTags) {
      if (typeof item === "string") {
        addTag(item, false);
      }
    }
  } else if (typeof existingTags === "string") {
    const parts = existingTags.split(/[,\s]+/);
    for (const part of parts) {
      if (part.trim().length > 0) {
        addTag(part, false);
      }
    }
  }

  if (Array.isArray(defaultTags)) {
    for (const defTag of defaultTags) {
      if (typeof defTag === "string") {
        addTag(defTag, true);
      }
    }
  }

  return result;
}

/**
 * Build initial Markdown content containing YAML frontmatter for a new companion `.md` note.
 */
export function buildInitialCompanionMarkdown(
  targetFileOrPath: TFile | string,
  settings: Pick<
    PluginSettings,
    "metadataFrontmatterKey" | "metadataDefaultTags"
  >,
  companionDirPath?: string
): string {
  const key =
    settings.metadataFrontmatterKey?.trim() || "file-support-target";
  const linkValue = formatTargetWikiLink(targetFileOrPath, companionDirPath);
  const tags = mergeFrontmatterTags([], settings.metadataDefaultTags ?? []);

  const lines: string[] = ["---", `${key}: "${linkValue}"`];
  if (tags.length > 0) {
    lines.push("tags:");
    for (const tag of tags) {
      lines.push(`  - ${tag}`);
    }
  }
  lines.push("---", "", "");
  return lines.join("\n");
}

/**
 * Update the Path/Name/Basename/Extension properties on a TFile-like object in place
 * if the underlying mock environment did not mutate the TFile during rename.
 */
export function syncFileObjectPath(file: TFile, newPath: string): void {
  const parts = splitFilePath(newPath);
  file.path = parts.path;
  file.name = parts.name;
  file.basename = parts.basename;
  file.extension = parts.extension;
}

/**
 * Lazily resolves `<target> <-> <companion.md>` pairs on demand without vault-wide startup scans.
 * Evaluates `enableMetadataFiles`, `metadataDirRegex`, and YAML frontmatter target links,
 * falling back from `<basename>.md` to `<basename>.<ext>.md` on same-folder collision.
 */
export class LazyPairResolver {
  private app: App;
  private getSettings: () => PluginSettings;
  private registry?: FileTypeRegistry;
  private pendingFrontmatterByPath: Map<string, Record<string, any>> =
    new Map();

  constructor(
    app: App,
    settingsOrGetter: PluginSettings | (() => PluginSettings),
    registry?: FileTypeRegistry
  ) {
    this.app = app;
    if (typeof settingsOrGetter === "function") {
      this.getSettings = settingsOrGetter;
    } else {
      let currentSettings = settingsOrGetter;
      this.getSettings = () => currentSettings;
    }
    this.registry = registry;
  }

  setApp(app: App): void {
    this.app = app;
  }

  getApp(): App {
    return this.app;
  }

  setRegistry(registry: FileTypeRegistry | undefined): void {
    this.registry = registry;
  }

  updateSettings(settings: PluginSettings): void {
    this.getSettings = () => settings;
  }

  getSettingsSnapshot(): PluginSettings {
    return this.getSettings();
  }

  getFileTypeConfig(fileOrExt: TFile | string): FileTypeConfig | undefined {
    const ext =
      typeof fileOrExt === "string"
        ? normalizeExtension(fileOrExt)
        : normalizeExtension(fileOrExt.extension);
    if (this.registry) {
      return this.registry.get(ext);
    }
    return this.getSettings()?.fileTypes?.[ext];
  }

  /**
   * Return true if companion metadata files are enabled in settings.
   */
  isMetadataEnabled(): boolean {
    return Boolean(this.getSettings()?.enableMetadataFiles);
  }

  /**
   * Evaluate whether a folder path (or a file's parent folder path when `isFilePath` is true)
   * matches `settings.metadataDirRegex`.
   * Safely catches malformed regular expressions and returns `false` on invalid syntax.
   */
  matchesDirectoryRegex(
    dirOrFilePath: string,
    isFilePath: boolean = false
  ): boolean {
    const settings = this.getSettings();
    const pattern = settings?.metadataDirRegex;
    if (typeof pattern !== "string") {
      return false;
    }

    const validation = validateDirectoryRegex(pattern);
    if (!validation.valid || !validation.regex) {
      return false;
    }

    const regex = validation.regex;
    const rawDir = isFilePath
      ? getParentDirPath(dirOrFilePath)
      : (dirOrFilePath ?? "");
    const dirPath =
      rawDir === "" || rawDir === "/" ? "" : normalizePath(rawDir);

    if (regex.test(dirPath)) {
      return true;
    }

    if (dirPath.length > 0 && pattern.includes("/")) {
      if (regex.test(`${dirPath}/`) || regex.test(`/${dirPath}`)) {
        return true;
      }
    } else if (
      dirPath.length === 0 &&
      (pattern === "/" || pattern === "^/$" || pattern === "^/")
    ) {
      if (regex.test("/")) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check whether a vault file path is eligible to have a companion `.md` metadata note.
   */
  isTargetPathEligible(filePath: string): boolean {
    if (!this.isMetadataEnabled()) {
      return false;
    }
    if (!filePath || typeof filePath !== "string") {
      return false;
    }

    const parts = splitFilePath(filePath);
    if (
      !parts.extension ||
      parts.extension === "md" ||
      parts.extension === "markdown"
    ) {
      return false;
    }

    if (this.registry && this.registry.isRegistered(parts.extension)) {
      if (!this.registry.isSupported(parts.extension)) {
        return false;
      }
    } else {
      const settings = this.getSettings();
      const configured = settings?.fileTypes?.[parts.extension];
      if (configured && configured.enabled === false) {
        return false;
      }
    }

    return this.matchesDirectoryRegex(parts.dir, false);
  }

  /**
   * Check whether a `TFile` is eligible to have a companion `.md` metadata note.
   */
  isTargetEligible(file: TFile | null | undefined): boolean {
    if (!file || !isTFileLike(file)) {
      return false;
    }
    return this.isTargetPathEligible(file.path);
  }

  /**
   * Compute the primary companion path (`<dir>/<basename>.md`).
   */
  getPrimaryCompanionPath(targetFileOrPath: TFile | string): string {
    const rawPath =
      typeof targetFileOrPath === "string"
        ? targetFileOrPath
        : targetFileOrPath.path;
    const parts = splitFilePath(rawPath);
    return parts.dir ? `${parts.dir}/${parts.basename}.md` : `${parts.basename}.md`;
  }

  /**
   * Compute the collision-fallback companion path (`<dir>/<basename>.<ext>.md`).
   */
  getFallbackCompanionPath(targetFileOrPath: TFile | string): string {
    const rawPath =
      typeof targetFileOrPath === "string"
        ? targetFileOrPath
        : targetFileOrPath.path;
    const parts = splitFilePath(rawPath);
    return parts.dir ? `${parts.dir}/${parts.name}.md` : `${parts.name}.md`;
  }

  /**
   * Look up a `TFile` in the vault by path, returning `null` if missing or a folder.
   */
  getTFileByPath(path: string): TFile | null {
    if (!path || !this.app?.vault?.getAbstractFileByPath) {
      return null;
    }
    const normalized = normalizePath(path);
    const found =
      this.app.vault.getAbstractFileByPath(normalized) ??
      (normalized !== path ? this.app.vault.getAbstractFileByPath(path) : null);
    return isTFileLike(found) ? found : null;
  }

  /**
   * Read the frontmatter object for a `.md` file from `app.metadataCache.getFileCache(file)`,
   * falling back to pending in-memory frontmatter only if `getFileCache(file)` returned null/undefined
   * (e.g. immediately after file creation before Obsidian's metadata indexer has run).
   */
  getFrontmatter(file: TFile): Record<string, any> | null {
    if (!file) {
      return null;
    }
    const cache = this.app?.metadataCache?.getFileCache?.(file);
    if (cache !== null && cache !== undefined) {
      if (cache.frontmatter && typeof cache.frontmatter === "object") {
        return cache.frontmatter;
      }
      return null;
    }
    return this.pendingFrontmatterByPath.get(normalizePath(file.path)) ?? null;
  }

  /**
   * Inspect a candidate `.md` file's YAML frontmatter to verify whether its
   * `file-support-target` property links to `targetFileOrPath`.
   */
  doesCompanionLinkToTarget(
    companionFile: TFile,
    targetFileOrPath: TFile | string
  ): boolean {
    if (!companionFile || normalizeExtension(companionFile.extension) !== "md") {
      return false;
    }
    const frontmatter = this.getFrontmatter(companionFile);
    if (!frontmatter) {
      return false;
    }
    const key =
      this.getSettings()?.metadataFrontmatterKey?.trim() ||
      "file-support-target";
    const rawValue = frontmatter[key];
    return doesFrontmatterLinkMatchTarget(
      rawValue,
      targetFileOrPath,
      getParentDirPath(companionFile.path),
      this.app
    );
  }

  /**
   * Lazily resolve the companion `.md` pairing for `targetFile`.
   * Returns `null` when companion metadata is disabled or `targetFile` is outside matching directories.
   */
  resolve(targetFile: TFile): CompanionPair | null {
    if (!this.isTargetEligible(targetFile)) {
      return null;
    }

    const primaryPath = this.getPrimaryCompanionPath(targetFile);
    const fallbackPath = this.getFallbackCompanionPath(targetFile);

    const primaryFile = this.getTFileByPath(primaryPath);
    if (primaryFile) {
      if (this.doesCompanionLinkToTarget(primaryFile, targetFile)) {
        return {
          targetFile,
          companionFile: primaryFile,
          expectedCompanionPath: primaryPath,
          usedFallbackName: false,
        };
      }

      // Collision on `<basename>.md` (it is a standalone note or linked to a different sibling file)
      const fallbackFile = this.getTFileByPath(fallbackPath);
      const matchedFallback =
        fallbackFile && this.doesCompanionLinkToTarget(fallbackFile, targetFile)
          ? fallbackFile
          : null;

      return {
        targetFile,
        companionFile: matchedFallback,
        expectedCompanionPath: fallbackPath,
        usedFallbackName: true,
      };
    }

    // Primary `<basename>.md` does not exist; check if a fallback `<basename>.<ext>.md` already exists and links here
    const fallbackFile = this.getTFileByPath(fallbackPath);
    if (
      fallbackFile &&
      this.doesCompanionLinkToTarget(fallbackFile, targetFile)
    ) {
      return {
        targetFile,
        companionFile: fallbackFile,
        expectedCompanionPath: fallbackPath,
        usedFallbackName: true,
      };
    }

    return {
      targetFile,
      companionFile: null,
      expectedCompanionPath: primaryPath,
      usedFallbackName: false,
    };
  }

  /**
   * Locate an existing companion `.md` file for a target path (such as `oldPath` during a vault rename
   * when the original target file is no longer at `oldPath`).
   * Accepts a companion at `<oldDir>/<oldBasename>.md` or `<oldDir>/<oldBasename>.<oldExt>.md`
   * whose frontmatter target matches either `oldTargetPath` or `currentTargetPath`.
   */
  resolveExistingCompanionForPath(
    oldTargetPath: string,
    currentTargetPath?: string
  ): TFile | null {
    const primaryPath = this.getPrimaryCompanionPath(oldTargetPath);
    const fallbackPath = this.getFallbackCompanionPath(oldTargetPath);

    const primaryFile = this.getTFileByPath(primaryPath);
    if (primaryFile) {
      if (
        this.doesCompanionLinkToTarget(primaryFile, oldTargetPath) ||
        (currentTargetPath !== undefined &&
          this.doesCompanionLinkToTarget(primaryFile, currentTargetPath))
      ) {
        return primaryFile;
      }
    }

    const fallbackFile = this.getTFileByPath(fallbackPath);
    if (fallbackFile) {
      if (
        this.doesCompanionLinkToTarget(fallbackFile, oldTargetPath) ||
        (currentTargetPath !== undefined &&
          this.doesCompanionLinkToTarget(fallbackFile, currentTargetPath))
      ) {
        return fallbackFile;
      }
    }

    return null;
  }

  /**
   * Determine the desired companion path (`<dir>/<basename>.md` vs `<dir>/<basename>.<ext>.md`)
   * for `targetFile` at its current location, accounting for collisions with existing notes
   * while allowing `existingCompanion` to occupy the primary path.
   */
  resolveDesiredCompanionPathForTarget(
    targetFile: TFile,
    existingCompanion?: TFile | null
  ): { expectedCompanionPath: string; usedFallbackName: boolean } {
    const primaryPath = this.getPrimaryCompanionPath(targetFile);
    const fallbackPath = this.getFallbackCompanionPath(targetFile);

    const primaryOccupant = this.getTFileByPath(primaryPath);
    if (
      !primaryOccupant ||
      (existingCompanion &&
        normalizePath(primaryOccupant.path) ===
          normalizePath(existingCompanion.path)) ||
      this.doesCompanionLinkToTarget(primaryOccupant, targetFile)
    ) {
      return {
        expectedCompanionPath: primaryPath,
        usedFallbackName: false,
      };
    }

    return {
      expectedCompanionPath: fallbackPath,
      usedFallbackName: true,
    };
  }

  /**
   * Reverse lookup: given a `.md` file, lazily determine whether it is an active companion note
   * and return its paired target `TFile` (or `null` if it is a regular Markdown note).
   */
  resolveTargetForCompanion(companionFile: TFile): TFile | null {
    if (
      !this.isMetadataEnabled() ||
      !companionFile ||
      normalizeExtension(companionFile.extension) !== "md"
    ) {
      return null;
    }

    const frontmatter = this.getFrontmatter(companionFile);
    if (!frontmatter) {
      return null;
    }

    const key =
      this.getSettings()?.metadataFrontmatterKey?.trim() ||
      "file-support-target";
    const linkTarget = extractWikiLinkTarget(frontmatter[key]);
    if (!linkTarget) {
      return null;
    }

    const companionDir = getParentDirPath(companionFile.path);
    const candidateTargetPath = linkTarget.includes("/")
      ? normalizePath(linkTarget)
      : companionDir
        ? `${companionDir}/${linkTarget}`
        : linkTarget;

    let targetFile = this.getTFileByPath(candidateTargetPath);
    if (!targetFile && this.app?.metadataCache?.getFirstLinkpathDest) {
      const fromCache = this.app.metadataCache.getFirstLinkpathDest(
        linkTarget,
        companionFile.path
      );
      if (isTFileLike(fromCache)) {
        targetFile = fromCache;
      }
    }

    if (!targetFile || !this.isTargetEligible(targetFile)) {
      return null;
    }

    const pair = this.resolve(targetFile);
    if (
      pair?.companionFile &&
      normalizePath(pair.companionFile.path) ===
        normalizePath(companionFile.path)
    ) {
      return targetFile;
    }

    return null;
  }

  /**
   * Build the initial Markdown string for a newly created companion note.
   */
  buildInitialCompanionContent(
    targetFileOrPath: TFile | string,
    companionPath?: string
  ): string {
    const companionDir =
      companionPath !== undefined
        ? getParentDirPath(companionPath)
        : getParentDirPath(targetFileOrPath);
    return buildInitialCompanionMarkdown(
      targetFileOrPath,
      this.getSettings(),
      companionDir
    );
  }

  /**
   * Non-destructively read/update YAML frontmatter on `companionFile` using
   * `app.fileManager.processFrontMatter`, writing `file-support-target: "[[<filename>.<ext>]]"`
   * and merging `metadataDefaultTags` without overwriting existing user properties or tags.
   */
  async writeCompanionFrontmatter(
    companionFile: TFile,
    targetFileOrPath: TFile | string,
    extraProps?: Record<string, unknown>,
    companionDirOverride?: string
  ): Promise<Record<string, any>> {
    const settings = this.getSettings();
    const key =
      settings?.metadataFrontmatterKey?.trim() || "file-support-target";
    const defaultTags = settings?.metadataDefaultTags ?? [];
    const companionDir =
      companionDirOverride !== undefined
        ? companionDirOverride
        : getParentDirPath(companionFile.path);
    const linkValue = formatTargetWikiLink(targetFileOrPath, companionDir);

    const normalizedCompanionPath = normalizePath(companionFile.path);
    const existingSnapshot =
      this.getFrontmatter(companionFile) ??
      this.pendingFrontmatterByPath.get(normalizedCompanionPath) ??
      {};
    let finalFrontmatter: Record<string, any> = { ...existingSnapshot };
    let callbackInvoked = false;

    const applyMutations = (fm: Record<string, any>) => {
      callbackInvoked = true;
      if (extraProps && typeof extraProps === "object") {
        for (const [propKey, propVal] of Object.entries(extraProps)) {
          if (propKey === key || propKey === "tags") {
            continue;
          }
          fm[propKey] = propVal;
        }
      }
      fm[key] = linkValue;

      const existingTagsSource =
        fm.tags !== undefined ? fm.tags : fm.tag !== undefined ? fm.tag : [];
      const extraTags =
        extraProps && Array.isArray(extraProps.tags)
          ? (extraProps.tags as string[])
          : [];
      const mergedTags = mergeFrontmatterTags(existingTagsSource, [
        ...defaultTags,
        ...extraTags,
      ]);
      if (mergedTags.length > 0 || fm.tags !== undefined) {
        fm.tags = mergedTags;
        if (fm.tag !== undefined) {
          delete fm.tag;
        }
      }
      finalFrontmatter = { ...fm };
    };

    if (typeof this.app?.fileManager?.processFrontMatter === "function") {
      await this.app.fileManager.processFrontMatter(
        companionFile,
        applyMutations
      );
    }

    if (!callbackInvoked) {
      applyMutations(finalFrontmatter);
    }

    this.pendingFrontmatterByPath.set(
      normalizePath(companionFile.path),
      finalFrontmatter
    );
    return finalFrontmatter;
  }

  /**
   * Update internal pending frontmatter tracking when a file is renamed.
   */
  handlePathRename(oldPath: string, newPath: string): void {
    const normOld = normalizePath(oldPath);
    const normNew = normalizePath(newPath);
    const existing = this.pendingFrontmatterByPath.get(normOld);
    if (existing) {
      this.pendingFrontmatterByPath.delete(normOld);
      this.pendingFrontmatterByPath.set(normNew, existing);
    }
  }

  /**
   * Remove internal pending frontmatter tracking for a deleted path.
   */
  invalidatePath(path: string): void {
    this.pendingFrontmatterByPath.delete(normalizePath(path));
  }
}
