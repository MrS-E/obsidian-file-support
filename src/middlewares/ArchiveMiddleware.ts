import type { App, TFile } from "obsidian";
import {
  getArchiveCompressionFormat,
  scanArchive,
  type ArchiveScanResult,
} from "../archives";
import type { EventBus, UnsubscribeFn } from "../core/EventBus";
import type {
  EditMode,
  FileEmbedEventPayload,
  FileOpenEventPayload,
  FileTypeConfig,
  RendererInstance,
  RendererMiddleware,
} from "../types/contracts";
import { registerRendererMiddleware } from "./TextCodeRendererMiddleware";

export const ARCHIVE_RENDERER_ID = "archive-viewer";

/** Maximum number of entries listed in an inline embed summary. */
const EMBED_ENTRY_LIMIT = 10;

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

/**
 * Format a byte count as a compact human-readable size (e.g. "1.5 KiB").
 */
function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * Read a vault file as raw bytes for archive scanning.
 */
async function readVaultFileBytes(app: App, file: TFile): Promise<ArrayBuffer> {
  const vault = app?.vault as any;
  if (!vault || typeof vault.readBinary !== "function") {
    throw new Error("Binary file reading is not available in this environment.");
  }
  return await vault.readBinary(file);
}

function renderArchiveHeader(
  rootEl: HTMLElement,
  file: TFile,
  result: ArchiveScanResult
): void {
  const headerEl = createEl(rootEl, "div", {
    cls: "file-support-archive-header",
  });
  createEl(headerEl, "span", {
    cls: "file-support-archive-title",
    text: file.name,
    attr: { title: file.path },
  });
  createEl(headerEl, "span", {
    cls: "file-support-archive-summary",
    text: `${result.entries.length} entries · ${formatByteSize(
      result.totalDecodedBytes
    )} · ${result.format}`,
  });
}

function renderEmptyArchive(rootEl: HTMLElement): void {
  createEl(rootEl, "div", {
    cls: "file-support-archive-empty",
    text: "This archive contains no entries.",
  });
}

/**
 * Render the full entry table for a dedicated archive tab.
 */
function renderArchiveTable(
  rootEl: HTMLElement,
  file: TFile,
  result: ArchiveScanResult
): void {
  renderArchiveHeader(rootEl, file, result);
  if (result.entries.length === 0) {
    renderEmptyArchive(rootEl);
    return;
  }

  const tableEl = createEl(rootEl, "table", {
    cls: "file-support-archive-table",
  });
  const headEl = createEl(tableEl, "thead");
  const headRowEl = createEl(headEl, "tr");
  for (const label of ["Path", "Size", "Type"]) {
    createEl(headRowEl, "th", { text: label });
  }

  const bodyEl = createEl(tableEl, "tbody");
  for (const entry of result.entries) {
    const rowEl = createEl(bodyEl, "tr", {
      attr: { "data-entry-type": entry.type },
    });
    createEl(rowEl, "td", {
      cls: "file-support-archive-path",
      text: entry.path,
      attr: { title: entry.path },
    });
    createEl(rowEl, "td", {
      cls: "file-support-archive-size",
      text: entry.type === "directory" ? "—" : formatByteSize(entry.size),
    });
    createEl(rowEl, "td", {
      cls: "file-support-archive-type",
      text: entry.type,
    });
  }
}

/**
 * Render a compact read-only summary for an inline `![[archive.tar]]` embed.
 */
function renderEmbedSummary(
  rootEl: HTMLElement,
  file: TFile,
  result: ArchiveScanResult
): void {
  renderArchiveHeader(rootEl, file, result);
  if (result.entries.length === 0) {
    renderEmptyArchive(rootEl);
    return;
  }

  const listEl = createEl(rootEl, "ul", {
    cls: "file-support-archive-embed-list",
  });
  for (const entry of result.entries.slice(0, EMBED_ENTRY_LIMIT)) {
    createEl(listEl, "li", {
      cls: "file-support-archive-embed-entry",
      text: `${entry.path} (${
        entry.type === "directory" ? "dir" : formatByteSize(entry.size)
      })`,
    });
  }

  const remaining = result.entries.length - EMBED_ENTRY_LIMIT;
  if (remaining > 0) {
    createEl(rootEl, "div", {
      cls: "file-support-archive-embed-more",
      text: `…and ${remaining} more entries`,
    });
  }
}

function renderArchiveError(rootEl: HTMLElement, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  createEl(rootEl, "div", {
    cls: "file-support-archive-error",
    text: `Unable to read archive: ${message}`,
  });
}

/**
 * Create the read-only RendererInstance backing a mounted archive view or embed.
 */
function createArchiveInstance(containerEl: HTMLElement): RendererInstance {
  return {
    getValue(): string {
      return "";
    },
    setValue(_data: string): void {
      // Archives are read-only; there is no editable text buffer.
    },
    setMode(_mode: EditMode): void {
      // Archives are always rendered read-only.
    },
    getMode(): EditMode {
      return "readonly";
    },
    destroy(): void {
      clearElement(containerEl);
    },
  };
}

/**
 * Renderer middleware that scans TAR archives (plain, gzip, bzip2, xz, zstd)
 * and renders their entry listing in dedicated tabs and inline embeds.
 */
export class ArchiveMiddleware implements RendererMiddleware {
  readonly id: string = ARCHIVE_RENDERER_ID;
  private readonly activeInstances: Set<RendererInstance> = new Set();
  private unsubscribeBus: UnsubscribeFn | null = null;

  supports(config: FileTypeConfig): boolean {
    if (!config || !config.enabled) {
      return false;
    }
    return config.rendererId === ARCHIVE_RENDERER_ID;
  }

  register(eventBus: EventBus): UnsubscribeFn {
    this.unsubscribeBus?.();
    this.unsubscribeBus = registerRendererMiddleware(eventBus, this);
    return () => {
      this.unsubscribeBus?.();
      this.unsubscribeBus = null;
    };
  }

  mountView(payload: FileOpenEventPayload): Promise<RendererInstance> {
    return this.mountArchive(payload, false);
  }

  mountEmbed(payload: FileEmbedEventPayload): Promise<RendererInstance> {
    return this.mountArchive(payload, true);
  }

  destroy(): void {
    this.unsubscribeBus?.();
    this.unsubscribeBus = null;
    for (const instance of Array.from(this.activeInstances)) {
      try {
        instance.destroy();
      } catch {
        // Ignore cleanup errors on already-destroyed views
      }
    }
    this.activeInstances.clear();
  }

  getActiveInstanceCount(): number {
    return this.activeInstances.size;
  }

  private async mountArchive(
    payload: FileOpenEventPayload | FileEmbedEventPayload,
    isEmbed: boolean
  ): Promise<RendererInstance> {
    const { app, file, containerEl } = payload;
    clearElement(containerEl);

    const rootEl = createEl(containerEl, "div", {
      cls: "file-support-archive-viewer",
      attr: {
        "data-extension": payload.config.extension,
        "data-edit-mode": "readonly",
      },
    });

    try {
      const format = getArchiveCompressionFormat(file.name);
      if (!format) {
        throw new Error(`Unsupported archive format for "${file.name}".`);
      }
      const buffer = await readVaultFileBytes(app, file);
      const result = await scanArchive(buffer, format);
      if (isEmbed) {
        renderEmbedSummary(rootEl, file, result);
      } else {
        renderArchiveTable(rootEl, file, result);
      }
    } catch (err) {
      renderArchiveError(rootEl, err);
    }

    return this.trackInstance(createArchiveInstance(containerEl), payload);
  }

  private trackInstance(
    instance: RendererInstance,
    payload: { instance?: RendererInstance }
  ): RendererInstance {
    this.activeInstances.add(instance);
    const originalDestroy = instance.destroy.bind(instance);
    let cleaned = false;
    instance.destroy = () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      this.activeInstances.delete(instance);
      originalDestroy();
    };
    payload.instance = instance;
    return instance;
  }
}
