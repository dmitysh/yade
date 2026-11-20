import { StreamLanguage } from "@codemirror/language";

export const environment = StreamLanguage.define({
  name: "env",
  startState: () => ({ value: false, quote: "" }),
  token(stream, state) {
    if (stream.sol() && !state.quote) state.value = false;
    if (!state.quote) {
      if (stream.sol() && stream.eat("\uFEFF")) return null;
      if (stream.eatSpace()) return null;
      if (stream.match(/#.*/)) return "comment";
      if (!state.value) {
        if (stream.match(/export\b/)) return "keyword";
        if (stream.match(/[A-Za-z_][\w]*(?=\s*=)/)) return "variableName.definition";
        if (stream.eat("=")) { state.value = true; return "operator"; }
        stream.skipToEnd(); return null;
      }
      const quote = stream.peek();
      if (quote !== "'" && quote !== '"') { stream.eatWhile(/[^#]/); return "string"; }
      state.quote = stream.next()!;
    }
    let escaped = false;
    for (let next; (next = stream.next()) !== undefined;) {
      if (next === state.quote && !escaped) { state.quote = ""; break; }
      escaped = !escaped && next === "\\";
    }
    return "string";
  },
  languageData: { commentTokens: { line: "#" }, closeBrackets: { brackets: ["'", '"'] } },
});
