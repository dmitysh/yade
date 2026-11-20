// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { terminalSnapshot, terminalTheme, TerminalOutput } from "./terminalOutput";

let terminal: Terminal;
afterEach(() => { cleanup(); terminal?.dispose(); });
async function snapshot(text: string, cols = 80) {
  terminal = new Terminal({ cols, rows: 4, theme: terminalTheme });
  await new Promise<void>(resolve => terminal.write(text, resolve));
  return terminalSnapshot(terminal.buffer.active);
}

test("блок сохраняет ANSI-цвета, сброс оформления и обычный текст для копирования", async () => {
  const output = await snapshot("\x1b[34mINFO\x1b[0m plain \x1b[32mPASS\x1b[0m\r\n\x1b[31mFAIL\x1b[0m");
  const panel = render(<TerminalOutput output={output} report={vi.fn()} />);
  expect(output.text).toBe("INFO plain PASS\nFAIL");
  expect(screen.getByText("INFO").style.color).toBe("rgb(52, 101, 164)");
  expect(screen.getByText("PASS").style.color).toBe("rgb(78, 154, 6)");
  expect(screen.getByText("FAIL").style.color).toBe("rgb(204, 0, 0)");
  expect(panel.container.querySelector("pre")?.textContent).toBe(output.text);
  expect(panel.container.querySelector("pre")?.style.color).toBe("");
});

test("256 цветов, RGB, фон и начертания остаются в блоке", async () => {
  const output = await snapshot("\x1b[1;31mbright\x1b[0m \x1b[38;5;202mindexed\x1b[0m \x1b[38;5;244mgrey\x1b[0m\r\n\x1b[3;4;9;38;2;12;34;56;48;2;65;43;21mstyled\x1b[0m \x1b[7minverse\x1b[0m \x1b[2mdim\x1b[0m");
  render(<TerminalOutput output={output} report={vi.fn()} />);
  expect(screen.getByText("bright").style.color).toBe("rgb(239, 41, 41)");
  expect(screen.getByText("bright").style.fontWeight).toBe("bold");
  expect(screen.getByText("indexed").style.color).toBe("rgb(255, 95, 0)");
  expect(screen.getByText("grey").style.color).toBe("rgb(128, 128, 128)");
  const style = screen.getByText("styled").style;
  expect(style.color).toBe("rgb(12, 34, 56)");
  expect(style.backgroundColor).toBe("rgb(65, 43, 21)");
  expect(style.fontStyle).toBe("italic");
  expect(style.textDecorationLine).toBe("underline line-through");
  expect(screen.getByText("inverse").style.color).toBe("rgb(30, 31, 34)");
  expect(screen.getByText("inverse").style.backgroundColor).toBe("rgb(223, 225, 229)");
  expect(screen.getByText("dim").style.opacity).toBe("0.5");
});

test("переносы, широкие символы и составные буквы сохраняют текст и цвет", async () => {
  const output = await snapshot("\x1b[32m界e\u0301🙂abcdef\x1b[0m\r\nplain", 6);
  const panel = render(<TerminalOutput output={output} report={vi.fn()} />);
  expect(output.text).toBe("界e\u0301🙂abcdef\nplain");
  expect(panel.container.querySelector("pre")?.textContent).toBe(output.text);
  expect(screen.getByText("界e\u0301🙂abcdef").style.color).toBe("rgb(78, 154, 6)");
  expect(panel.container.querySelector("pre")?.lastChild?.textContent).toBe("plain");
});

test("смена цвета внутри пути и URL сохраняет целые ссылки, вывод остаётся текстом", async () => {
  const openFile = vi.fn(async () => {}), report = vi.fn();
  const output = await snapshot("\x1b[31msrc/\x1b[32mApp.tsx:12\x1b[0m https://\x1b[34mexample.com\x1b[0m <script>alert(1)</script>");
  const panel = render(<TerminalOutput output={output} workspacePath="/project" openFile={openFile} report={report} />);
  const link = screen.getByRole("link", { name: "src/App.tsx:12" });
  expect(link.querySelectorAll("span")).toHaveLength(2);
  fireEvent.click(link);
  expect(openFile).toHaveBeenCalledWith("src/App.tsx", expect.objectContaining({ line: 12, column: 1 }));
  expect(screen.getByRole("link", { name: "https://example.com" }).getAttribute("href")).toBe("https://example.com");
  expect(panel.container.querySelector("script")).toBeNull();
  expect(panel.container.querySelector("pre")?.textContent).toBe(output.text);
  expect(report).not.toHaveBeenCalled();
});
