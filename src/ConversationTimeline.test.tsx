// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import ConversationTimeline from "./ConversationTimeline";
import type { ConversationData } from "./types";

afterEach(cleanup);

test("шаги показывают первую строку, раскрываются независимо и сохраняют раскрытие при обновлениях", () => {
  const context = { workspaceId: "w", sessionId: "s", runId: "run" };
  const data: ConversationData = {
    session: { id: "s", executor: "codex", workspaceId: "w", title: "Разговор", state: "running", externalId: null },
    context, canStop: true, messages: [], messageEvents: {}, requests: [], olderMessages: false, olderEvents: false, draft: "",
    events: [
      { sequence: 1, context, kind: "action_started", payload: { id: "cmd", type: "commandExecution", command: "первая команда\r\nвторая команда" } },
      { sequence: 2, context, kind: "action_output", payload: { method: "item/commandExecution/outputDelta", params: { itemId: "cmd", delta: "первая строка\nвторая строка" } } },
      { sequence: 3, context, kind: "action_completed", payload: { id: "thought", type: "reasoning", summary: "Первая мысль\nВторая мысль" } },
    ],
  };
  const panel = () => <ConversationTimeline data={data} executor="Codex" active canReply={false} reply={async () => {}} />;
  const view = render(panel());
  const step = screen.getByLabelText("Команда: Выполняется");
  const thought = screen.getByLabelText("Размышление: Завершено");
  expect(step.querySelector("pre")?.textContent).toBe("первая команда");
  expect(thought.querySelector("pre")?.textContent).toBe("Первая мысль");
  const toggle = within(step).getByRole("button", { name: "Развернуть полный вывод" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toBe(step.lastElementChild);
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(step.textContent).toContain("вторая команда");
  expect(step.textContent).toContain("вторая строка");
  expect(thought.textContent).not.toContain("Вторая мысль");
  data.events.push({ sequence: 4, context, kind: "action_output", payload: { method: "item/commandExecution/outputDelta", params: { itemId: "cmd", delta: "\nтретья строка" } } });
  view.rerender(panel());
  expect(step.textContent).toContain("третья строка");
  fireEvent.click(within(step).getByRole("button", { name: "Свернуть вывод" }));
  expect(step.querySelector("pre")?.textContent).toBe("первая команда");
  fireEvent.click(within(thought).getByRole("button", { name: "Развернуть полный вывод" }));
  expect(thought.textContent).toContain("Вторая мысль");
});
