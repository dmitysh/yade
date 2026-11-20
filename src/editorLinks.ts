import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

function webUrl(value: string) {
  if (!/^https?:\/\//i.test(value)) return null;
  try { new URL(value); return value; } catch { return null; }
}

export function editorLinkAt(state: EditorState, position: number): string | null {
  let node = syntaxTree(state).resolveInner(position, 1);
  while (node.name !== "Link" && node.name !== "Autolink" && node.parent) node = node.parent;
  if (node.name === "Link" || node.name === "Autolink") {
    const url = node.getChild("URL");
    return url ? webUrl(state.sliceDoc(url.from, url.to).replace(/^<|>$/g, "").replace(/\\([\\`*{}\[\]()#+.!_<>-])/g, "$1")) : null;
  }
  const line = state.doc.lineAt(position);
  for (const match of line.text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    let value = match[0];
    const brackets: string[] = [];
    for (let i = 0; i < value.length; i++) {
      const char = value[i];
      if ("([{".includes(char)) brackets.push(char);
      else if (")]}".includes(char) && brackets.pop() !== { ")": "(", "]": "[", "}": "{" }[char]) { value = value.slice(0, i); break; }
    }
    value = value.replace(/[.,;:!?]+$/, "");
    if (position >= line.from + match.index && position < line.from + match.index + value.length) return webUrl(value);
  }
  return null;
}

export const editorLinks = EditorView.domEventHandlers({ mousedown(event, view) {
  if (event.button !== 0 || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return false;
  const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
  const url = position === null ? null : editorLinkAt(view.state, position);
  if (!url) return false;
  event.preventDefault();
  window.open(url, "_blank", "noopener,noreferrer");
  return true;
} });
