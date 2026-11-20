import type { IBuffer, IBufferRange, ILink } from "@xterm/xterm";
import { resolveFileLink, type FileLink, type FileLinks } from "./fileLinks";

function hardPathWrap(buffer: IBuffer, row: number) {
  if (buffer.getLine(row)?.isWrapped) return false;
  const before = buffer.getLine(row - 1)?.translateToString(true).match(/[^\s<>"'`|()[\]{}]+$/)?.[0];
  const after = buffer.getLine(row)?.translateToString(true).trimStart().match(/^[^\s<>"'`|()[\]{}]+/)?.[0]?.replace(/[.,;:!?]+$/, "");
  return !!before?.endsWith("/") && !!after && /[/.]|:\d+$/.test(after);
}

export function terminalFileLinks(buffer: IBuffer, row: number, workspacePath: string, open: (link: FileLink) => void, fileWorkspaces?: FileLinks["fileWorkspaces"]): ILink[] {
  const continues = (y: number) => buffer.getLine(y)?.isWrapped || hardPathWrap(buffer, y);
  let first = row - 1;
  while (first > 0 && continues(first)) first--;
  let text = "";
  const cells: IBufferRange[] = [];
  for (let y = first; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line || (y > first && !continues(y))) break;
    let from = 0, to = line.length;
    // Программы могут переносить пути сами и добавлять отступ на следующей строке.
    if (y > first && hardPathWrap(buffer, y)) while (from < to && !line.getCell(from)!.getChars().trim()) from++;
    if (hardPathWrap(buffer, y + 1)) while (to > from && !line.getCell(to - 1)!.getChars().trim()) to--;
    for (let x = from; x < to; x++) {
      const cell = line.getCell(x)!;
      if (!cell.getWidth()) continue;
      const chars = cell.getChars() || " ";
      text += chars;
      for (let i = 0; i < chars.length; i++) cells.push({
        start: { x: x + 1, y: y + 1 }, end: { x: x + cell.getWidth(), y: y + 1 },
      });
    }
  }
  const links: ILink[] = [];
  for (const match of text.matchAll(/"([^"\r\n]+)"|'([^'\r\n]+)'|[^\s<>"'`|()[\]{}]+/g)) {
    const value = (match[1] ?? match[2] ?? match[0]).replace(/[.,;:!?]+$/, "");
    if (!/[/.]/.test(value) && !/^(?:Makefile|Dockerfile|README|LICENSE)(?::\d+)?$/.test(value)) continue;
    const target = resolveFileLink(value, workspacePath, fileWorkspaces);
    if (!target) continue;
    const start = match.index + (match[1] || match[2] ? 1 : 0);
    const range = { start: cells[start].start, end: cells[start + value.length - 1].end };
    if (row < range.start.y || row > range.end.y) continue;
    links.push({ text: value, range, activate: () => open(target) });
  }
  return links;
}
