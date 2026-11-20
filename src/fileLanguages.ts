import { LanguageDescription, LanguageSupport, StreamLanguage } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { Extension } from "@codemirror/state";
import { fileTypes } from "./fileTypes";

export const editorLanguages = fileTypes.filter(type => type.id !== "text").map(type => LanguageDescription.of({
  name: type.id,
  alias: type.aliases,
  extensions: type.extensions,
  load: () => loadSupport(type.id),
}));

async function loadSupport(id: string): Promise<LanguageSupport> {
  if (id === "Markdown") {
    const { markdown } = await import("@codemirror/lang-markdown");
    return markdown({ codeLanguages: info => LanguageDescription.matchLanguageName(editorLanguages, info.split(/\s+/)[0], false) });
  }
  if (id === "JSONC") {
    const { json } = await import("@codemirror/legacy-modes/mode/javascript");
    return new LanguageSupport(StreamLanguage.define(json));
  }
  if (id === "Env") {
    const { environment } = await import("./environmentLanguage");
    return new LanguageSupport(environment);
  }
  return languages.find(language => language.name === (id === "SVG" ? "XML" : id))!.load();
}

export function loadFileLanguage(id: string): Promise<Extension> {
  return editorLanguages.find(language => language.name === id)?.load() ?? Promise.resolve([]);
}
