import { createContext, useContext, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { defaultEditorTheme, editorThemeVariables, isEditorTheme, type EditorTheme } from "./editorThemes";
import { builtinEditorThemes } from "./builtinEditorThemes";
import "./appearance.css";

export const textFonts = {
  inter: { name: "Inter", family: '"Inter", system-ui, sans-serif' },
  system: { name: "Системный", family: "system-ui, sans-serif" },
  serif: { name: "С засечками", family: "ui-serif, Georgia, serif" },
};
export const monoFonts = {
  jetbrains: { name: "JetBrains Mono", family: '"JetBrains Mono", ui-monospace, monospace' },
  system: { name: "Системный моноширинный", family: "ui-monospace, monospace" },
};
export const scales = [75, 90, 100, 110, 125, 150];
export const fontSizes = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24];
export const appearanceKey = "yade.appearance";
export interface Appearance {
  interfaceFont: keyof typeof textFonts; chatFont: keyof typeof textFonts;
  editorFont: keyof typeof monoFonts; terminalFont: keyof typeof monoFonts;
  interfaceFontSize: number; chatFontSize: number; editorFontSize: number; terminalFontSize: number;
  scale: number; wrapCode: boolean; chatFormat: "formatted" | "source";
  editorTheme: string | null; editorThemes: EditorTheme[];
}
export const defaultAppearance: Appearance = {
  interfaceFont: "inter", chatFont: "inter", editorFont: "jetbrains", terminalFont: "jetbrains",
  interfaceFontSize: 9.75, chatFontSize: 10.5, editorFontSize: 9, terminalFontSize: 9.75,
  scale: 100, wrapCode: true, chatFormat: "formatted",
  editorTheme: null, editorThemes: [],
};

export function appearanceZoom(scale: number) { return 1.05 * scale / 100; }

function load() {
  try {
    const value = JSON.parse(localStorage.getItem(appearanceKey) ?? "null");
    const appearance = { ...defaultAppearance };
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const key of ["interfaceFont", "chatFont"] as const) {
        if (Object.hasOwn(textFonts, value[key])) appearance[key] = value[key];
      }
      for (const key of ["editorFont", "terminalFont"] as const) {
        if (Object.hasOwn(monoFonts, value[key])) appearance[key] = value[key];
      }
      for (const key of ["interfaceFontSize", "chatFontSize", "editorFontSize", "terminalFontSize"] as const) {
        if (fontSizes.includes(value[key]) || value[key] === defaultAppearance[key]) appearance[key] = value[key];
      }
      if (scales.includes(value.scale)) appearance.scale = value.scale;
      if (typeof value.wrapCode === "boolean") appearance.wrapCode = value.wrapCode;
      if (["formatted", "source"].includes(value.chatFormat)) appearance.chatFormat = value.chatFormat;
      if (Array.isArray(value.editorThemes)) appearance.editorThemes = value.editorThemes.slice(0, 256).filter(isEditorTheme);
      if ([...builtinEditorThemes, ...appearance.editorThemes].some(theme => theme.id === value.editorTheme)) appearance.editorTheme = value.editorTheme;
    }
    return { appearance, error: "" };
  } catch {
    return { appearance: { ...defaultAppearance }, error: "Настройки внешнего вида не прочитаны. Используются исходные значения." };
  }
}

const AppearanceContext = createContext({
  appearance: defaultAppearance, theme: defaultEditorTheme, themes: builtinEditorThemes, error: "", update: (_patch: Partial<Appearance>) => {},
});
export function useAppearance() { return useContext(AppearanceContext); }

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(load);
  const { appearance, error } = state;
  const themes = [
    ...builtinEditorThemes.map(theme => appearance.editorThemes.find(imported => imported.id === theme.id) ?? theme),
    ...appearance.editorThemes.filter(theme => !builtinEditorThemes.some(builtin => builtin.id === theme.id)),
  ];
  const theme = themes.find(theme => theme.id === appearance.editorTheme) ?? defaultEditorTheme;
  function update(patch: Partial<Appearance>) {
    setState(state => {
      const next = { ...state.appearance, ...patch };
      let error = "";
      try { localStorage.setItem(appearanceKey, JSON.stringify(next)); }
      catch { error = "Настройки применены, но не сохранены. После перезапуска они будут сброшены."; }
      return { appearance: next, error };
    });
  }
  return <AppearanceContext.Provider value={{ appearance, theme, themes, error, update }}>
    <div className="appearance-root" style={{
      ...editorThemeVariables(theme),
      "--font-interface": textFonts[appearance.interfaceFont].family,
      "--font-chat": textFonts[appearance.chatFont].family,
      "--font-editor": monoFonts[appearance.editorFont].family,
      "--font-terminal": monoFonts[appearance.terminalFont].family,
      "--font-size-interface": `${appearance.interfaceFontSize}pt`,
      "--font-size-chat": `${appearance.chatFontSize}pt`,
      "--font-size-editor": `${appearance.editorFontSize}pt`,
      "--font-size-terminal": `${appearance.terminalFontSize}pt`,
      "--interface-font-scale": appearance.interfaceFontSize / defaultAppearance.interfaceFontSize,
      "--appearance-scale": appearanceZoom(appearance.scale),
    } as CSSProperties}>{children}</div>
  </AppearanceContext.Provider>;
}
