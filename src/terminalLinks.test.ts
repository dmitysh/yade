// @vitest-environment jsdom
import { Terminal } from "@xterm/xterm";
import { expect, test, vi } from "vitest";
import { terminalFileLinks } from "./terminalLinks";

test("пути в выводе терминала сохраняют позиции и не подменяют внешние ссылки", async () => {
  const terminal = new Terminal({ cols: 160, rows: 10 });
  try {
    await new Promise<void>(resolve => terminal.write('src/App.tsx:12:3 (README.md) "docs/мой файл.md" /other/file.ts https://example.org/file.ts', resolve));
    const open = vi.fn();
    const links = terminalFileLinks(terminal.buffer.active, 1, "/project", open);
    expect(links.map(link => link.text)).toEqual(["src/App.tsx:12:3", "README.md", "docs/мой файл.md"]);
    expect(links[0].range).toEqual({ start: { x: 1, y: 1 }, end: { x: 16, y: 1 } });
    links[0].activate(new MouseEvent("click"), links[0].text);
    expect(open).toHaveBeenCalledWith({ path: "src/App.tsx", line: 12, column: 3 });
  } finally { terminal.dispose(); }
});

test("длинная ссылка распознаётся на обеих строках переноса после широкого символа", async () => {
  const terminal = new Terminal({ cols: 20, rows: 10 });
  try {
    await new Promise<void>(resolve => terminal.write("界 /project/src/long-filename.ts:12:3", resolve));
    for (const row of [1, 2]) {
      const links = terminalFileLinks(terminal.buffer.active, row, "/project", vi.fn());
      expect(links).toHaveLength(1);
      expect(links[0].text).toBe("/project/src/long-filename.ts:12:3");
      expect(links[0].range).toEqual({ start: { x: 4, y: 1 }, end: { x: 17, y: 2 } });
    }
  } finally { terminal.dispose(); }
});

test("путь, перенесённый программой после слеша, открывается целиком с обеих строк", async () => {
  const terminal = new Terminal({ cols: 100, rows: 10 });
  try {
    await new Promise<void>(resolve => terminal.write("Выход всегда 16:9 (macos/Sources/StreamerCore/\r\n  StreamResolution.swift:14). Если окно выше", resolve));
    const open = vi.fn();
    for (const row of [1, 2]) {
      const links = terminalFileLinks(terminal.buffer.active, row, "/project", open);
      expect(links.map(link => link.text)).toEqual(["macos/Sources/StreamerCore/StreamResolution.swift:14"]);
      links[0].activate(new MouseEvent("click"), links[0].text);
      expect(open).toHaveBeenLastCalledWith({ path: "macos/Sources/StreamerCore/StreamResolution.swift", line: 14, column: 1 });
    }
  } finally { terminal.dispose(); }
});

test("путь через несколько явных переносов сохраняет координаты всех частей", async () => {
  const terminal = new Terminal({ cols: 80, rows: 10 });
  try {
    await new Promise<void>(resolve => terminal.write("Файл (macos/Sources/\r\n    StreamerCore/\r\n  StreamResolution.swift:14).", resolve));
    for (const row of [1, 2, 3]) {
      const links = terminalFileLinks(terminal.buffer.active, row, "/project", vi.fn());
      expect(links).toHaveLength(1);
      expect(links[0].text).toBe("macos/Sources/StreamerCore/StreamResolution.swift:14");
      expect(links[0].range).toEqual({ start: { x: 7, y: 1 }, end: { x: 27, y: 3 } });
    }
  } finally { terminal.dispose(); }
});

test("отдельные пути на соседних строках не склеиваются, внешний путь не становится локальным", async () => {
  const terminal = new Terminal({ cols: 100, rows: 10 });
  try {
    await new Promise<void>(resolve => terminal.write("src/first.ts:12\r\nsrc/second.ts:14\r\n/other/src/\r\n  second.ts:14", resolve));
    expect(terminalFileLinks(terminal.buffer.active, 1, "/project", vi.fn()).map(link => link.text)).toEqual(["src/first.ts:12"]);
    expect(terminalFileLinks(terminal.buffer.active, 2, "/project", vi.fn()).map(link => link.text)).toEqual(["src/second.ts:14"]);
    for (const row of [3, 4]) expect(terminalFileLinks(terminal.buffer.active, row, "/project", vi.fn())).toEqual([]);
  } finally { terminal.dispose(); }
});

test("путь другого добавленного проекта в выводе терминала сохраняет проект и строку", async () => {
  const terminal = new Terminal({ cols: 120, rows: 10 });
  try {
    await new Promise<void>(resolve => terminal.write("Код (/other/internal/models.go:293).", resolve));
    const open = vi.fn();
    const links = terminalFileLinks(terminal.buffer.active, 1, "/project", open, [{ id: "other", path: "/other" }]);
    expect(links).toHaveLength(1);
    links[0].activate(new MouseEvent("click"), links[0].text);
    expect(open).toHaveBeenCalledWith({ path: "internal/models.go", line: 293, column: 1, workspaceId: "other" });
  } finally { terminal.dispose(); }
});
