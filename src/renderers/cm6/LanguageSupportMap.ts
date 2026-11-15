import { StreamLanguage } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { cpp } from "@codemirror/lang-cpp";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { cmake } from "@codemirror/legacy-modes/mode/cmake";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { normalizeExtension } from "../../core/FileTypeRegistry";

export type LanguageExtensionFactory = () => Extension;

const BUILT_IN_LANGUAGE_FACTORIES: Readonly<
  Record<string, LanguageExtensionFactory>
> = Object.freeze({
  plaintext: () => [],
  text: () => [],
  txt: () => [],
  log: () => [],
  json: () => json(),
  javascript: () => javascript(),
  js: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  typescript: () => javascript({ typescript: true }),
  ts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  c: () => cpp(),
  h: () => cpp(),
  cpp: () => cpp(),
  hpp: () => cpp(),
  cc: () => cpp(),
  cxx: () => cpp(),
  python: () => python(),
  py: () => python(),
  xml: () => xml(),
  html: () => xml(),
  yaml: () => yaml(),
  yml: () => yaml(),
  ruby: () => StreamLanguage.define(ruby),
  rb: () => StreamLanguage.define(ruby),
  shell: () => StreamLanguage.define(shell),
  sh: () => StreamLanguage.define(shell),
  bash: () => StreamLanguage.define(shell),
  zsh: () => StreamLanguage.define(shell),
  toml: () => StreamLanguage.define(toml),
  properties: () => StreamLanguage.define(properties),
  ini: () => StreamLanguage.define(properties),
  cfg: () => StreamLanguage.define(properties),
  conf: () => StreamLanguage.define(properties),
  diff: () => StreamLanguage.define(diff),
  patch: () => StreamLanguage.define(diff),
  cmake: () => StreamLanguage.define(cmake),
});

const customLanguageFactories: Map<string, LanguageExtensionFactory> = new Map();

/**
 * Register or override a custom CodeMirror 6 language extension factory for a language ID.
 */
export function registerLanguageSupport(
  languageId: string,
  factory: LanguageExtensionFactory
): void {
  const key = normalizeExtension(languageId);
  if (!key) {
    return;
  }
  customLanguageFactories.set(key, factory);
}

/**
 * Remove a previously registered custom language extension factory.
 */
export function unregisterLanguageSupport(languageId: string): boolean {
  const key = normalizeExtension(languageId);
  return customLanguageFactories.delete(key);
}

/**
 * Resolve a CodeMirror 6 language Extension for the given `languageId` (or fallback `extension`).
 * Returns an empty extension array (`[]`) for plain text or unknown languages.
 */
export function resolveLanguageExtension(
  languageId?: string,
  extension?: string
): Extension {
  const candidates = [languageId, extension]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => normalizeExtension(v));

  for (const key of candidates) {
    const custom = customLanguageFactories.get(key);
    if (custom) {
      return custom();
    }
    if (Object.prototype.hasOwnProperty.call(BUILT_IN_LANGUAGE_FACTORIES, key)) {
      return BUILT_IN_LANGUAGE_FACTORIES[key]();
    }
  }

  return [];
}
