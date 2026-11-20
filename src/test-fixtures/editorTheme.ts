export const vscodeTheme = {
  id: "test.theme:themes/light.json", name: "Светлая проверочная", dark: false,
  colors: {
    "editor.background": "#fafafa", "editor.foreground": "#202020",
    "editorLineNumber.foreground": "#666666", "editorCursor.foreground": "#333333",
    "editor.selectionBackground": "#aabbcc", "editor.lineHighlightBackground": "#eeeeee",
    "diffEditor.insertedLineBackground": "#ddffdd", "diffEditor.removedLineBackground": "#ffdddd",
  },
  tokenColors: [
    { scope: ["keyword", "storage"], settings: { foreground: "#990099" } },
    { scope: "string, markup.raw", settings: { foreground: "#228822" } },
    { scope: "constant.numeric, constant.language", settings: { foreground: "#006699" } },
    { scope: "comment, markup.quote", settings: { foreground: "#666666", fontStyle: "italic" } },
    { scope: "entity.name, support.type", settings: { foreground: "#993300" } },
    { scope: "variable, entity.other.attribute-name, support.type.property-name", settings: { foreground: "#334499" } },
    { scope: "markup.heading", settings: { foreground: "#660099", fontStyle: "bold" } },
    { scope: "markup.inserted", settings: { foreground: "#006600" } },
    { scope: "markup.deleted", settings: { foreground: "#990000" } },
  ],
};
