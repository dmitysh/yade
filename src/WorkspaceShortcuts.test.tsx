// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import WorkspaceShortcuts from "./WorkspaceShortcuts";
import { ShortcutProvider, shortcutsKey } from "./shortcuts";
import type { Tab, Workspace } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({ id: "created" })) }));
HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });
const workspace: Workspace = { id: "w1", projectId: "p1", name: "Основное", path: "/project", kind: "folder", groupId: null,
  archived: false, deleted: false, sourceRef: null, sourceCommit: null, gitRef: null, operationState: "ready", operationError: null,
  preparationCommand: null, preparationState: "skipped", preparationOutput: "" };
const initialTabs: Tab[] = [
  { id: "session:s1", sessionId: "s1", workspaceId: "w1" },
  { id: "terminal:t1", sessionId: null, workspaceId: "w1" },
  { id: "file:w1:notes.txt", sessionId: null, workspaceId: "w1" },
];

function Harness({ initial = initialTabs, busy = false, otherWorkspace = false, opened = vi.fn(), closed = vi.fn(), projects = vi.fn() }: {
  initial?: Tab[]; busy?: boolean; otherWorkspace?: boolean; opened?: (id: string) => void; closed?: (id: string) => void; projects?: () => void;
}) {
  const [tabs, setTabs] = useState(initial);
  const [active, setActive] = useState<string | undefined>(initial[0]?.id);
  const [menu, setMenu] = useState(false);
  const [modal, setModal] = useState(false);
  async function activate(tab: Tab) { setActive(tab.id); opened(tab.id); }
  return <ShortcutProvider><div className="ide-live">
    <WorkspaceShortcuts tabs={otherWorkspace ? [] : tabs} activeTab={tabs.find(tab => tab.id === active)} workspace={workspace} busy={busy}
      title={tab => tab.id} activate={activate} close={async tab => { closed(tab.id); setTabs(current => current.filter(item => item.id !== tab.id)); setActive(undefined); }}
      openTerminal={async id => { opened(id); }} projects={projects} files={() => {}} git={() => {}} findText={() => {}} settings={() => setModal(true)} reveal={() => {}} report={() => {}} />
    <button className="ide-new-tab" aria-label="Новая вкладка" aria-expanded={menu} onClick={() => setMenu(true)}>+</button>
    {menu && <div role="menu" aria-label="Новая вкладка" />}
    {tabs.map(tab => <section id={tab.id} key={tab.id}><button onClick={() => void activate(tab)}>{tab.id}</button><textarea aria-label={`Ввод ${tab.id}`} /></section>)}
    {modal && <dialog open aria-label="Настройки"><input aria-label="Поиск настроек" /></dialog>}
  </div></ShortcutProvider>;
}

test("переключатель использует историю, ждёт отпускания Ctrl и возвращается к предыдущей вкладке", async () => {
  const opened = vi.fn();
  render(<Harness opened={opened} />);
  fireEvent.click(screen.getByRole("button", { name: "terminal:t1" }));
  fireEvent.click(screen.getByRole("button", { name: "file:w1:notes.txt" }));
  opened.mockClear();
  fireEvent.keyDown(window, { key: "Tab", code: "Tab", ctrlKey: true });
  expect(screen.getByRole("option", { name: "terminal:t1", selected: true })).toBeTruthy();
  expect(opened).not.toHaveBeenCalled();
  fireEvent.keyUp(window, { key: "Control", code: "ControlLeft" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(opened).toHaveBeenLastCalledWith("terminal:t1");
  fireEvent.keyDown(window, { key: "Tab", code: "Tab", ctrlKey: true });
  expect(screen.getByRole("option", { name: "file:w1:notes.txt", selected: true })).toBeTruthy();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(opened).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("обратное переключение и стрелки меняют только выбор; вкладки другого пространства не участвуют", () => {
  const opened = vi.fn();
  const panel = render(<Harness opened={opened} />);
  fireEvent.keyDown(window, { key: "Tab", code: "Tab", ctrlKey: true, shiftKey: true });
  expect(screen.getByRole("option", { name: "file:w1:notes.txt", selected: true })).toBeTruthy();
  fireEvent.keyDown(window, { key: "ArrowUp", code: "ArrowUp", ctrlKey: true });
  expect(screen.getByRole("option", { name: "terminal:t1", selected: true })).toBeTruthy();
  fireEvent.keyUp(window, { key: "Control" });
  expect(opened).toHaveBeenLastCalledWith("terminal:t1");
  panel.rerender(<Harness opened={opened} otherWorkspace />);
  fireEvent.keyDown(window, { key: "Tab", code: "Tab", ctrlKey: true });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(opened).toHaveBeenCalledTimes(1);
});

test("закрывается область с фокусом; закрытие последней вкладки и повторный CmdW не завершают работу", () => {
  const closed = vi.fn();
  render(<Harness initial={[initialTabs[0]]} closed={closed} />);
  const input = screen.getByRole("textbox", { name: "Ввод session:s1" });
  input.focus();
  fireEvent.keyDown(input, { key: "ц", code: "KeyW", metaKey: true });
  expect(closed).toHaveBeenCalledExactlyOnceWith("session:s1");
  fireEvent.keyDown(window, { key: "w", code: "KeyW", metaKey: true });
  expect(closed).toHaveBeenCalledTimes(1);
  expect(invoke).not.toHaveBeenCalled();
});

test("при фокусе в другой области закрывается именно её вкладка", () => {
  const closed = vi.fn();
  render(<Harness closed={closed} />);
  const terminal = screen.getByRole("textbox", { name: "Ввод terminal:t1" });
  terminal.focus();
  fireEvent.keyDown(terminal, { key: "w", code: "KeyW", metaKey: true });
  expect(closed).toHaveBeenCalledExactlyOnceWith("terminal:t1");
});

test("переход к беседе выбирает существующую, а при её отсутствии открывает создание", async () => {
  const opened = vi.fn();
  let panel = render(<Harness opened={opened} />);
  fireEvent.keyDown(window, { key: " ", code: "Space", metaKey: true, shiftKey: true });
  expect(opened).toHaveBeenCalledWith("session:s1");
  panel.unmount();
  panel = render(<Harness initial={[]} />);
  fireEvent.keyDown(window, { key: " ", code: "Space", metaKey: true, shiftKey: true });
  await screen.findByRole("menu", { name: "Новая вкладка" });
  expect(invoke).not.toHaveBeenCalled();
});

test("переход к терминалу создаёт его один раз, затем открывает; при занятости создание запрещено", async () => {
  const opened = vi.fn();
  const panel = render(<Harness initial={[]} opened={opened} />);
  fireEvent.keyDown(window, { key: "F12", code: "F12", altKey: true });
  fireEvent.keyDown(window, { key: "F12", code: "F12", altKey: true });
  await waitFor(() => expect(opened).toHaveBeenCalledWith("created"));
  expect(invoke).toHaveBeenCalledExactlyOnceWith("start_terminal", { workspaceId: "w1", cols: 80, rows: 24 });
  panel.rerender(<Harness initial={[]} opened={opened} busy />);
  fireEvent.keyDown(window, { key: "F12", code: "F12", altKey: true });
  expect(invoke).toHaveBeenCalledTimes(1);
});

test("диалог блокирует общие команды; переопределённое сочетание работает вместо исходного", () => {
  localStorage.setItem(shortcutsKey, JSON.stringify({ projects: "Meta+KeyE" }));
  const projects = vi.fn();
  render(<Harness projects={projects} />);
  fireEvent.keyDown(window, { key: "k", code: "KeyK", metaKey: true });
  expect(projects).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: "у", code: "KeyE", metaKey: true });
  expect(projects).toHaveBeenCalledOnce();
  fireEvent.keyDown(window, { key: ",", code: "Comma", metaKey: true });
  fireEvent.keyDown(screen.getByLabelText("Поиск настроек"), { key: "e", code: "KeyE", metaKey: true });
  expect(projects).toHaveBeenCalledOnce();
});
