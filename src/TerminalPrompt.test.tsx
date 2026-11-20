// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { TerminalCommand, TerminalPrompt } from "./TerminalPrompt";

afterEach(cleanup);
test("приглашение показывает каталог и ветку, сокращая только домашний каталог", () => {
  const view = render(<TerminalPrompt cwd="/home/user/project" home="/home/user" branch="main" />);
  expect(screen.getByText("~/project")).toBeTruthy();
  expect(screen.getByText("main")).toBeTruthy();
  view.rerender(<TerminalPrompt cwd="/home/user-other/project" home="/home/user" />);
  expect(screen.getByText("/home/user-other/project")).toBeTruthy();
});
test("подсветка команды сохраняет аргументы и несколько строк без изменения текста", () => {
  const command = "printf 'one'\nprintf 'two'";
  const view = render(<TerminalCommand command={command} known />);
  expect(view.container.textContent).toBe(command);
  expect(view.container.querySelector('.terminal-executable')?.textContent).toBe("printf");
});
test("неподтверждённое имя команды не получает зелёную подсветку", () => {
  const view = render(<TerminalCommand command="codfdsfasf" />);
  expect(view.container.textContent).toBe("codfdsfasf");
  expect(view.container.querySelector('.terminal-executable')).toBeNull();
});
