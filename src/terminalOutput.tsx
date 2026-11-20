import { memo, type CSSProperties } from "react";
import type { IBuffer, IBufferCell } from "@xterm/xterm";
import { openFileLink, resolveFileLink, type FileLinks } from "./fileLinks";

const ansiColors = {
  black: "#2e3436", red: "#cc0000", green: "#4e9a06", yellow: "#c4a000",
  blue: "#3465a4", magenta: "#75507b", cyan: "#06989a", white: "#d3d7cf",
  brightBlack: "#555753", brightRed: "#ef2929", brightGreen: "#8ae234", brightYellow: "#fce94f",
  brightBlue: "#729fcf", brightMagenta: "#ad7fa8", brightCyan: "#34e2e2", brightWhite: "#eeeeec",
};
export const terminalTheme = { background: "#1e1f22", foreground: "#dfe1e5", ...ansiColors };
const palette = Object.values(ansiColors);

export interface TerminalSnapshot { text: string; styles: { offset: number; style: CSSProperties }[] }

function paletteColor(index: number) {
  if (index < 16) return palette[index];
  if (index >= 232) { const grey = 8 + (index - 232) * 10; return `rgb(${grey}, ${grey}, ${grey})`; }
  const levels = [0, 95, 135, 175, 215, 255];
  const value = index - 16;
  return `rgb(${levels[Math.floor(value / 36)]}, ${levels[Math.floor(value / 6) % 6]}, ${levels[value % 6]})`;
}

function cellStyle(cell: IBufferCell): CSSProperties {
  if (cell.isAttributeDefault()) return {};
  let fg = cell.getFgColor();
  if (cell.isFgPalette() && cell.isBold() && fg < 8) fg += 8;
  const rgb = (value: number) => `#${value.toString(16).padStart(6, "0")}`;
  let color = cell.isFgRGB() ? rgb(fg) : cell.isFgPalette() ? paletteColor(fg) : undefined;
  let backgroundColor = cell.isBgRGB() ? rgb(cell.getBgColor()) : cell.isBgPalette() ? paletteColor(cell.getBgColor()) : undefined;
  if (cell.isInverse()) [color, backgroundColor] = [backgroundColor ?? terminalTheme.background, color ?? terminalTheme.foreground];
  const decoration = [cell.isUnderline() && "underline", cell.isStrikethrough() && "line-through", cell.isOverline() && "overline"].filter(Boolean).join(" ");
  return {
    color, backgroundColor, fontWeight: cell.isBold() ? "bold" : undefined,
    fontStyle: cell.isItalic() ? "italic" : undefined, opacity: cell.isDim() ? 0.5 : undefined,
    visibility: cell.isInvisible() ? "hidden" : undefined, textDecorationLine: decoration || undefined,
  };
}

export function terminalSnapshot(buffer: IBuffer): TerminalSnapshot {
  let text = "", previousStyle = "";
  const styles: TerminalSnapshot["styles"] = [];
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    if (y && !line.isWrapped) text += "\n";
    const value = line.translateToString(!buffer.getLine(y + 1)?.isWrapped);
    const start = text.length;
    let offset = start;
    for (let x = 0; x < line.length && offset < start + value.length; x++) {
      const cell = line.getCell(x);
      if (!cell?.getWidth()) continue;
      const style = cellStyle(cell), key = JSON.stringify(style);
      if (key !== previousStyle) { styles.push({ offset, style }); previousStyle = key; }
      offset += (cell.getChars() || " ").length;
    }
    text += value;
  }
  return { text: text.trimEnd(), styles };
}

export const TerminalOutput = memo(function TerminalOutput({ output, workspacePath, fileWorkspaces, openFile, report }: {
  output: TerminalSnapshot; report: (reason: unknown) => void;
} & FileLinks) {
  let run = 0;
  return <pre>{Array.from(output.text.matchAll(/\s+|\S+/g), match => {
    let offset = match.index;
    const end = offset + match[0].length, parts = [];
    while (offset < end) {
      while (run + 1 < output.styles.length && output.styles[run + 1].offset <= offset) run++;
      const next = Math.min(end, output.styles[run + 1]?.offset ?? end);
      const text = output.text.slice(offset, next), style = output.styles[run]?.style;
      parts.push(style && Object.keys(style).length ? <span key={offset} style={style}>{text}</span> : text);
      offset = next;
    }
    const value = match[0].replace(/[.,;]+$/, "");
    const target = workspacePath && openFile && /[/.]/.test(value) ? resolveFileLink(value, workspacePath, fileWorkspaces) : null;
    if (target) return <a key={match.index} href={value} onClick={event => { event.preventDefault(); void openFileLink(target, openFile!).catch(report); }}>{parts}</a>;
    return /^https?:\/\//i.test(value) ? <a key={match.index} href={value} target="_blank" rel="noreferrer">{parts}</a> : parts;
  })}</pre>;
});
