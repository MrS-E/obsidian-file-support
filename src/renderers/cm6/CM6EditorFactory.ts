import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import {
  Annotation,
  Compartment,
  EditorState,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import type { EditMode, RendererInstance } from "../../types/contracts";
import { resolveLanguageExtension } from "./LanguageSupportMap";

/**
 * Internal annotation allowing programmatic `setValue` calls to update the document
 * even when the editor's readOnly compartment is active.
 */
export const allowProgrammaticChangeAnnotation = Annotation.define<boolean>();

export interface LineRangeSubpath {
  startLine: number;
  endLine?: number;
}

/**
 * Parse a line-range subpath such as "#L5", "L5-L12", or "#L5-12" (1-based inclusive).
 */
export function parseLineRangeSubpath(
  subpath?: string
): LineRangeSubpath | null {
  if (!subpath || typeof subpath !== "string") {
    return null;
  }
  const cleaned = subpath.trim().replace(/^#/, "");
  const match = /^L(\d+)(?:-L?(\d+))?$/i.exec(cleaned);
  if (!match) {
    return null;
  }
  const startLine = Math.max(1, parseInt(match[1], 10));
  const endLine = match[2] ? Math.max(startLine, parseInt(match[2], 10)) : startLine;
  return { startLine, endLine };
}

/**
 * Slice content according to an optional line-range subpath.
 */
export function applySubpathToContent(
  content: string,
  subpath?: string
): { text: string; startLine: number } {
  const range = parseLineRangeSubpath(subpath);
  if (!range) {
    return { text: content, startLine: 1 };
  }
  const lines = content.split(/\r?\n/);
  const startIdx = Math.min(lines.length, range.startLine - 1);
  const endIdx =
    range.endLine !== undefined
      ? Math.min(lines.length, range.endLine)
      : startIdx + 1;
  if (startIdx >= lines.length) {
    return { text: "", startLine: range.startLine };
  }
  return {
    text: lines.slice(startIdx, endIdx).join("\n"),
    startLine: range.startLine,
  };
}

/**
 * Build the CodeMirror 6 extension array for the dynamic readOnly / editable Compartment.
 * Enforces read-only state via:
 * 1. `EditorState.readOnly.of(isReadOnly)`
 * 2. `EditorView.editable.of(!isReadOnly)`
 * 3. `EditorState.transactionFilter` rejecting unannotated document modifications when read-only.
 */
export function buildReadOnlyCompartmentExtension(mode: EditMode): Extension {
  const isReadOnly = mode !== "editable";
  return [
    EditorState.readOnly.of(isReadOnly),
    EditorView.editable.of(!isReadOnly),
    EditorState.transactionFilter.of((tr) => {
      if (
        isReadOnly &&
        tr.docChanged &&
        !tr.annotation(allowProgrammaticChangeAnnotation)
      ) {
        return [];
      }
      return tr;
    }),
  ];
}

export interface CM6EditorMountOptions {
  containerEl: HTMLElement;
  initialData: string;
  mode: EditMode;
  languageId?: string;
  extension?: string;
  isEmbed?: boolean;
  subpath?: string;
  onContentChange?: (newData: string) => void;
  extraExtensions?: Extension[];
}

export interface CM6RendererInstance extends RendererInstance {
  readonly view: EditorView;
  readonly readOnlyCompartment: Compartment;
  readonly wrapperEl: HTMLElement;
  getState(): EditorState;
  isReadOnly(): boolean;
}

function resolveDomHost(containerEl: HTMLElement): {
  mountParent: HTMLElement;
  wrapperEl: HTMLElement;
} {
  const hasRealDom =
    typeof containerEl === "object" &&
    containerEl !== null &&
    Boolean((containerEl as any).ownerDocument);

  if (hasRealDom) {
    const doc = (containerEl as any).ownerDocument as Document;
    const wrapperEl = doc.createElement("div");
    containerEl.appendChild(wrapperEl);
    return { mountParent: wrapperEl, wrapperEl };
  }

  // Fallback when containerEl is a lightweight mock element in tests
  const doc = typeof document !== "undefined" ? document : null;
  if (!doc) {
    throw new Error(
      "CodeMirror 6 requires a DOM document to mount EditorView."
    );
  }
  const realWrapper = doc.createElement("div");
  if (typeof (containerEl as any).appendChild === "function") {
    (containerEl as any).appendChild(realWrapper);
  }
  return { mountParent: realWrapper, wrapperEl: realWrapper };
}

function applyModeAttributes(el: HTMLElement, mode: EditMode): void {
  const isReadOnly = mode !== "editable";
  el.setAttribute("data-edit-mode", mode);
  el.classList.toggle("is-readonly", isReadOnly);
  el.classList.toggle("is-editable", !isReadOnly);
}

/**
 * Factory creating CodeMirror 6 editor instances with dynamic read-only Compartment
 * reconfiguration and language syntax highlighting.
 */
export class CM6EditorFactory {
  static createEditor(options: CM6EditorMountOptions): CM6RendererInstance {
    const readOnlyCompartment = new Compartment();
    let currentMode: EditMode =
      options.mode === "editable" ? "editable" : "readonly";
    let destroyed = false;

    const { text: initialDoc, startLine } = options.isEmbed
      ? applySubpathToContent(options.initialData ?? "", options.subpath)
      : { text: options.initialData ?? "", startLine: 1 };

    const { mountParent, wrapperEl } = resolveDomHost(options.containerEl);
    wrapperEl.classList.add("file-support-cm6-wrapper");
    if (options.isEmbed) {
      wrapperEl.classList.add("file-support-cm6-embed-wrapper");
    } else {
      wrapperEl.classList.add("file-support-cm6-tab-wrapper");
    }
    applyModeAttributes(wrapperEl, currentMode);

    const languageExtension = resolveLanguageExtension(
      options.languageId,
      options.extension
    );

    const lineNumberExtension =
      startLine > 1
        ? lineNumbers({
            formatNumber: (lineNo) => String(lineNo + startLine - 1),
          })
        : lineNumbers();

    const extensions: Extension[] = [
      lineNumberExtension,
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      bracketMatching(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      keymap.of([
        indentWithTab,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
      ]),
      languageExtension,
      readOnlyCompartment.of(buildReadOnlyCompartmentExtension(currentMode)),
      EditorView.updateListener.of((update) => {
        if (destroyed || !update.docChanged) {
          return;
        }
        const isProgrammatic = update.transactions.some((tr) =>
          Boolean(tr.annotation(allowProgrammaticChangeAnnotation))
        );
        if (isProgrammatic) {
          return;
        }
        if (currentMode === "editable" && !update.state.readOnly) {
          options.onContentChange?.(update.state.doc.toString());
        }
      }),
      ...(options.extraExtensions ?? []),
    ];

    const state = EditorState.create({
      doc: initialDoc,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: mountParent,
    });

    const instance: CM6RendererInstance = {
      view,
      readOnlyCompartment,
      wrapperEl,

      getValue(): string {
        return view.state.doc.toString();
      },

      setValue(data: string): void {
        if (destroyed) {
          return;
        }
        const nextText = options.isEmbed
          ? applySubpathToContent(data ?? "", options.subpath).text
          : (data ?? "");
        const currentText = view.state.doc.toString();
        if (currentText === nextText) {
          return;
        }
        view.dispatch({
          changes: {
            from: 0,
            to: view.state.doc.length,
            insert: nextText,
          },
          annotations: allowProgrammaticChangeAnnotation.of(true),
        });
      },

      setMode(mode: EditMode): void {
        if (destroyed) {
          return;
        }
        const normalizedMode: EditMode =
          mode === "editable" ? "editable" : "readonly";
        if (
          normalizedMode === currentMode &&
          view.state.readOnly === (normalizedMode === "readonly")
        ) {
          return;
        }
        currentMode = normalizedMode;
        applyModeAttributes(wrapperEl, currentMode);
        view.dispatch({
          effects: readOnlyCompartment.reconfigure(
            buildReadOnlyCompartmentExtension(currentMode)
          ),
        });
      },

      getMode(): EditMode {
        return currentMode;
      },

      isReadOnly(): boolean {
        return view.state.readOnly;
      },

      getState(): EditorState {
        return view.state;
      },

      focus(): void {
        if (!destroyed) {
          view.focus();
        }
      },

      destroy(): void {
        if (destroyed) {
          return;
        }
        destroyed = true;
        view.destroy();
        if (wrapperEl.parentNode) {
          wrapperEl.parentNode.removeChild(wrapperEl);
        } else if (Array.isArray((options.containerEl as any).children)) {
          const children = (options.containerEl as any).children as unknown[];
          const idx = children.indexOf(wrapperEl);
          if (idx !== -1) {
            children.splice(idx, 1);
          }
        }
      },
    };

    return instance;
  }
}
