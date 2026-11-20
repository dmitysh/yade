import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags, type Tag } from "@lezer/highlight";

export const editorColors = {
  background: ["editor.background", "#1e1f22", "#ffffff"],
  foreground: ["editor.foreground", "#bcbec4", "#333333"],
  "gutter-background": ["editorGutter.background", "#1e1f22", "#ffffff"],
  "gutter-border": ["editorRuler.foreground", "#343944", "#dddddd"],
  "line-number": ["editorLineNumber.foreground", "#737782", "#777777"],
  "active-line-number": ["editorLineNumber.activeForeground", "#bcbec4", "#333333"],
  cursor: ["editorCursor.foreground", "#b9bac0", "#333333"],
  selection: ["editor.selectionBackground", "#264f78", "#add6ff"],
  "inactive-selection": ["editor.inactiveSelectionBackground", "#3a3d41", "#e5ebf1"],
  "selection-match": ["editor.selectionHighlightBackground", "#add6ff26", "#add6ff80"],
  "active-line": ["editor.lineHighlightBackground", "#30333a", "#f2f2f2"],
  "active-line-border": ["editor.lineHighlightBorder", "transparent", "transparent"],
  "search-match": ["editor.findMatchBackground", "#9e6a03", "#f2c55c"],
  "search-match-border": ["editor.findMatchBorder", "transparent", "transparent"],
  "search-other": ["editor.findMatchHighlightBackground", "#ea5c0055", "#ea5c0055"],
  "search-other-border": ["editor.findMatchHighlightBorder", "transparent", "transparent"],
  bracket: ["editorBracketMatch.background", "#ffffff19", "#00640019"],
  "bracket-border": ["editorBracketMatch.border", "#888888", "#b9b9b9"],
  "added-line": ["diffEditor.insertedLineBackground", "#1e3a2c", "#e6ffed"],
  "deleted-line": ["diffEditor.removedLineBackground", "#3e282d", "#ffeef0"],
  "added-text": ["diffEditor.insertedTextBackground", "#3d775450", "#9ccc6580"],
  "deleted-text": ["diffEditor.removedTextBackground", "#6b343f70", "#ffcccc80"],
  "gutter-added": ["editorGutter.addedBackground", "#6aab73", "#22863a"],
  "gutter-modified": ["editorGutter.modifiedBackground", "#56a8f5", "#005cc5"],
  "gutter-deleted": ["editorGutter.deletedBackground", "#f75464", "#cb2431"],
  "panel-background": ["editorWidget.background", "#252526", "#f3f3f3"],
  "panel-foreground": ["editorWidget.foreground", "#bcbec4", "#333333"],
  "panel-border": ["editorWidget.border", "#454545", "#c8c8c8"],
  "input-background": ["input.background", "#3c3c3c", "#ffffff"],
  "input-foreground": ["input.foreground", "#cccccc", "#333333"],
  "input-border": ["input.border", "#555555", "#cecece"],
  "focus-border": ["focusBorder", "#007fd4", "#0090f1"],
} as const;

export interface TokenStyle {
  color?: string;
  fontStyle?: "normal" | "italic";
  fontWeight?: "normal" | "bold";
  textDecoration?: string;
}
export interface EditorTheme {
  id: string; name: string; dark: boolean;
  colors: Record<keyof typeof editorColors, string>;
  syntax: Record<string, TokenStyle>;
}

const syntaxRules: [string, Tag | Tag[], string[], TokenStyle][] = [
  ["keyword", tags.keyword, ["keyword.control", "storage.type", "storage.modifier"], { color: "#cf8e6d" }],
  ["string", tags.string, ["string.quoted.double", "string.quoted.single", "string.unquoted"], { color: "#6aab73" }],
  ["regexp", tags.regexp, ["string.regexp"], { color: "#6aab73" }],
  ["escape", tags.escape, ["constant.character.escape"], { color: "#cf8e6d" }],
  ["comment", tags.comment, ["comment.line", "comment.block"], { color: "#7a7e85", fontStyle: "italic" }],
  ["number", tags.number, ["constant.numeric"], { color: "#2aacb8" }],
  ["atom", tags.atom, ["constant.language", "constant.other"], { color: "#2aacb8" }],
  ["bool", tags.bool, ["constant.language.boolean", "constant.language"], { color: "#2aacb8" }],
  ["null", tags.null, ["constant.language.null", "constant.language"], { color: "#2aacb8" }],
  ["variable", tags.variableName, ["variable.other.readwrite", "variable"], { color: "#bcbec4" }],
  ["property", tags.propertyName, ["variable.other.property", "support.type.property-name", "meta.object-literal.key"], { color: "#c77dbb" }],
  ["attribute", tags.attributeName, ["entity.other.attribute-name"], { color: "#c77dbb" }],
  ["function", [tags.function(tags.variableName), tags.function(tags.propertyName)], ["entity.name.function", "support.function"], { color: "#56a8f5" }],
  ["definition", tags.definition(tags.variableName), ["entity.name.variable", "variable.other.readwrite", "variable"], { color: "#bcbec4" }],
  ["operator", tags.operator, ["keyword.operator"], { color: "#bcbec4" }],
  ["punctuation", tags.punctuation, ["punctuation"], { color: "#bcbec4" }],
  ["attributeValue", [tags.attributeValue, tags.special(tags.string)], ["string.quoted.double", "string.quoted.single"], { color: "#6aab73" }],
  ["meta", tags.meta, ["meta.preprocessor", "punctuation.definition.preprocessor"], { color: "#b3ae60" }],
  ["annotation", tags.annotation, ["storage.type.annotation", "entity.name.function.decorator"], { color: "#b3ae60" }],
  ["label", tags.labelName, ["entity.name.label"], { color: "#b3ae60" }],
  ["invalid", tags.invalid, ["invalid"], { color: "#f75464" }],
  ["type", tags.typeName, ["entity.name.type", "support.type", "storage.type.primitive"], { color: "#b4a3d9" }],
  ["class", tags.className, ["entity.name.type.class", "entity.name.class", "support.class"], { color: "#b4a3d9" }],
  ["tag", tags.tagName, ["entity.name.tag"], { color: "#b4a3d9" }],
  ["standard", tags.standard(tags.variableName), ["support.variable", "support.constant"], { color: "#b4a3d9" }],
  ["heading", tags.heading, ["markup.heading.markdown", "markup.heading", "entity.name.section"], { color: "#b4a3d9", fontWeight: "bold" }],
  ["strong", tags.strong, ["markup.bold.markdown", "markup.bold"], { fontWeight: "bold" }],
  ["emphasis", tags.emphasis, ["markup.italic.markdown", "markup.italic"], { fontStyle: "italic" }],
  ["link", tags.link, ["markup.underline.link.markdown", "markup.underline.link", "string.other.link.title.markdown", "string.other.link"], { color: "#56a8f5", textDecoration: "underline" }],
  ["url", tags.url, ["markup.underline.link", "markup.underline.link.markdown"], { color: "#56a8f5", textDecoration: "underline" }],
  ["monospace", tags.monospace, ["markup.inline.raw.string.markdown", "markup.raw.inline.markdown", "markup.raw.block.markdown", "markup.inline.raw", "markup.raw"], { color: "#6aab73" }],
  ["quote", tags.quote, ["markup.quote.markdown", "markup.quote"], { color: "#7a7e85", fontStyle: "italic" }],
  ["separator", [tags.processingInstruction, tags.contentSeparator], ["meta.separator", "meta.preprocessor"], { color: "#cf8e6d" }],
  ["inserted", tags.inserted, ["markup.inserted"], { color: "#6aab73" }],
  ["deleted", tags.deleted, ["markup.deleted"], { color: "#f75464" }],
  ["changed", tags.changed, ["markup.changed"], { color: "#56a8f5" }],
];

function palette(dark: boolean): EditorTheme["colors"] {
  return Object.fromEntries(Object.entries(editorColors).map(([key, values]) => [key, values[dark ? 1 : 2]])) as EditorTheme["colors"];
}
export const defaultEditorTheme: EditorTheme = {
  id: "", name: "Исходная тема Yade", dark: true, colors: palette(true),
  syntax: Object.fromEntries(syntaxRules.map(([name, , , style]) => [name, style])),
};

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function color(value: unknown): value is string {
  return typeof value === "string" && /^(#[\da-f]{3,4}|#[\da-f]{6}|#[\da-f]{8}|transparent)$/i.test(value);
}
function style(value: unknown): TokenStyle {
  if (!object(value)) throw new Error("Некорректное правило подсветки темы.");
  const result: TokenStyle = {};
  if (value.foreground != null) {
    if (!color(value.foreground)) throw new Error("Некорректный цвет синтаксиса в теме.");
    result.color = value.foreground;
  }
  if (value.fontStyle != null) {
    const flags = typeof value.fontStyle === "string" ? value.fontStyle.trim().split(/\s+/).filter(Boolean) : null;
    if (!flags || flags.some(flag => !["normal", "regular", "italic", "bold", "underline", "strikethrough"].includes(flag))) {
      throw new Error("Некорректный стиль текста в теме.");
    }
    result.fontStyle = flags.includes("italic") ? "italic" : "normal";
    result.fontWeight = flags.includes("bold") ? "bold" : "normal";
    result.textDecoration = [flags.includes("underline") ? "underline" : "", flags.includes("strikethrough") ? "line-through" : ""].filter(Boolean).join(" ") || "none";
  }
  return result;
}

export function importEditorTheme(value: unknown): EditorTheme {
  if (!object(value) || typeof value.id !== "string" || !value.id || value.id.length > 4096
    || typeof value.name !== "string" || !value.name || value.name.length > 200 || typeof value.dark !== "boolean"
    || !object(value.colors) || !Array.isArray(value.tokenColors) || value.tokenColors.length > 16384) {
    throw new Error("Некорректное описание темы VS Code.");
  }
  const colors = palette(value.dark);
  const rules = value.tokenColors.map(raw => {
    if (!object(raw)) throw new Error("Некорректное правило подсветки темы.");
    const scope = raw.scope == null ? [] : Array.isArray(raw.scope) ? raw.scope : [raw.scope];
    if (!scope.every((item: unknown) => typeof item === "string")) throw new Error("Некорректная область подсветки темы.");
    return { scopes: (scope as string[]).flatMap(item => item.split(",")).map(item => item.trim()).filter(Boolean), style: style(raw.settings), settings: raw.settings as Record<string, unknown> };
  });
  let global: TokenStyle = {};
  for (const rule of rules.filter(rule => !rule.scopes.length)) {
    global = { ...global, ...rule.style };
    if (rule.style.color) colors.foreground = rule.style.color;
    if (color(rule.settings.background)) colors.background = rule.settings.background;
  }
  for (const [key, [source]] of Object.entries(editorColors)) {
    const raw = value.colors[source];
    if (raw != null) {
      if (!color(raw)) throw new Error("Некорректный цвет темы: " + source);
      colors[key as keyof typeof editorColors] = raw;
    }
  }
  if (value.colors["editorGutter.background"] == null) colors["gutter-background"] = colors.background;
  if (value.colors["editorCursor.foreground"] == null) colors.cursor = colors.foreground;
  if (value.colors["editorWidget.foreground"] == null) colors["panel-foreground"] = colors.foreground;
  const syntax = Object.fromEntries(syntaxRules.map(([name, , scopes, base]) => {
    const fallback = name === "inserted" ? colors["gutter-added"] : name === "deleted" ? colors["gutter-deleted"] : name === "changed" ? colors["gutter-modified"] : colors.foreground;
    const result: TokenStyle = { ...global, ...base };
    if (base.color) result.color = fallback;
    else delete result.color;
    const matches = rules.map(rule => ({
      rule,
      // shortcut: контекстные правила TextMate требуют отдельного движка; здесь сопоставляются общие категории синтаксиса.
      score: Math.max(0, ...rule.scopes.filter(selector => /^[\w.-]+$/.test(selector))
        .filter(selector => scopes.some(scope => scope === selector || scope.startsWith(selector + "."))).map(selector => selector.split(".").length)),
    })).filter(match => match.score > 0).sort((a, b) => a.score - b.score);
    for (const { rule } of matches) Object.assign(result, rule.style);
    return [name, result];
  }));
  return { id: value.id, name: value.name, dark: value.dark, colors, syntax };
}

export function isEditorTheme(value: unknown): value is EditorTheme {
  return object(value) && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 4096
    && typeof value.name === "string" && value.name.length > 0 && value.name.length <= 200 && typeof value.dark === "boolean"
    && object(value.colors) && Object.keys(editorColors).every(key => color((value.colors as Record<string, unknown>)[key]))
    && object(value.syntax) && syntaxRules.every(([name]) => {
      const item = (value.syntax as Record<string, unknown>)[name];
      return object(item) && Object.entries(item).every(([key, value]) => key === "color" ? color(value)
        : key === "fontStyle" ? typeof value === "string" && ["normal", "italic"].includes(value)
        : key === "fontWeight" ? typeof value === "string" && ["normal", "bold"].includes(value)
        : key === "textDecoration" && typeof value === "string" && ["none", "underline", "line-through", "underline line-through"].includes(value));
    });
}

export function editorHighlightStyle(theme: EditorTheme) {
  return HighlightStyle.define(syntaxRules.map(([name, tag]) => ({ tag, ...theme.syntax[name] })));
}
export function editorThemeExtension(theme: EditorTheme) {
  return [EditorView.theme({}, { dark: theme.dark }), syntaxHighlighting(editorHighlightStyle(theme))];
}
export function editorThemeVariables(theme: EditorTheme) {
  return Object.fromEntries(Object.entries(theme.colors).map(([key, value]) => ["--editor-" + key, value]));
}
