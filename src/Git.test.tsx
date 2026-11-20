// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import Git from "./Git";
import { commitGraph, readGitDraft } from "./gitState";
import type { GitChange, GitCommit, GitStatus } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./CodeEditor", () => ({ Comparison: ({ a, b, hunks, stageHunk, busy }: any) => <div aria-label="Сравнение версий">{a}|{b}{hunks?.hunks.map((_: string, index: number) => <button key={index} disabled={busy} onClick={() => stageHunk(index)}>Включить фрагмент {index + 1} в коммит</button>)}</div> }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); localStorage.clear(); });
HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
const target = { workspaceId: "w", repository: "" };
const change = (path: string, index = " ", worktree = "M"): GitChange => ({ path, index, worktree, conflict: false, originalPath: null });
const status = (changes: GitChange[] = []): GitStatus => ({ reference: "main", changes, remotes: ["origin"], upstream: "origin/main", ahead: 2, behind: 0, operation: null });
const versions = [{ name: "HEAD", text: "исходный" }, { name: "Индекс Git", text: "подготовленный" }, { name: "Файл на диске", text: "рабочий" }];
const expected = { path: "one", index: "oid", worktree: "version", patch: "patch", hunks: ["@@ first\n-old\n+new\n", "@@ second\n-old2\n+new2\n"] };
const commit: GitCommit = { hash: "a".repeat(40), parents: ["b".repeat(40)], author: "Дмитрий", email: "test@example.invalid", time: "2026-11-12T14:32:00+03:00", refs: "HEAD -> main", subject: "Выравнять блоки сравнения" };

function mockGit(overrides: Record<string, (args: any) => unknown> = {}) {
  const defaults: typeof overrides = {
    list_git_repositories: () => [""], git_status: () => status([change("one"), change("two")]),
    git_branches: () => [{ name: "main", reference: "refs/heads/main", kind: "local", current: true, upstream: "origin/main" }, { name: "feature", reference: "refs/heads/feature", kind: "local", current: false, upstream: "" }],
    git_stashes: () => [], git_versions: () => versions, git_diff: () => expected,
    git_history: () => ({ commits: [commit], hasMore: false }),
    git_commit_details: () => ({ hash: commit.hash, message: `${commit.subject}\n\nСинхронизировать строки.`, files: [{ path: "src/Diff.tsx", added: 18, deleted: 9 }] }),
  };
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    const handler = overrides[command] ?? defaults[command];
    if (!handler) throw new Error(`неожиданная команда: ${command}`);
    return await handler(args);
  });
}
function choose(label: string, option: string) { fireEvent.click(screen.getByRole("combobox", { name: label })); fireEvent.click(screen.getByRole("option", { name: option })); }
function menu(label: string, item: string) { fireEvent.click(screen.getByRole("button", { name: label })); fireEvent.click(screen.getByRole("menuitem", { name: item })); }
async function openGit(workspaceId = "w", projectId?: string) { render(<Git workspaceId={workspaceId} projectId={projectId} open={vi.fn()} />); fireEvent.click(screen.getByRole("button", { name: "Git" })); await screen.findByRole("combobox", { name: "Текущая ветка" }); }
function confirm() { fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Подтвердить" })); }

test("чистая рабочая папка показывает переход к истории без формы коммита", async () => {
  mockGit({ git_status: () => status() }); await openGit();
  expect(screen.queryByLabelText("Сообщение коммита")).toBeNull();
  expect(screen.queryByLabelText("Найти изменённый файл")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Посмотреть историю" }));
  await screen.findByRole("heading", { name: commit.subject });
  expect(screen.getByRole("tab", { name: "История" }).getAttribute("aria-selected")).toBe("true");
});

test("общий флажок выбирает только найденные файлы и исключает конфликты", async () => {
  mockGit({ git_status: () => status([change("src/one"), change("README.md"), { ...change("src/conflict", "U", "U"), conflict: true }]), stage_git_files: () => null });
  await openGit();
  fireEvent.change(screen.getByLabelText("Найти изменённый файл"), { target: { value: "src/" } });
  expect(screen.getByText("1 файл")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "Включить все файлы" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("stage_git_files", { target, paths: ["src/one"] }));
});

test("Git загружается явно и изолирует состояние выбранного вложенного репозитория", async () => {
  mockGit({ list_git_repositories: () => ["first", "second"], git_status: args => ({ ...status(), reference: args.target.repository }) });
  render(<Git workspaceId="group" open={vi.fn()} />);
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Git" }));
  await screen.findByRole("combobox", { name: "Репозиторий" });
  choose("Репозиторий", "second");
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("git_status", { target: { workspaceId: "group", repository: "second" } }));
  expect(invoke).toHaveBeenCalledWith("git_branches", { target: { workspaceId: "group", repository: "second" } });
});

test("папка без Git не запускает операции в родительском репозитории", async () => {
  mockGit({ list_git_repositories: () => [] });
  render(<Git workspaceId="ordinary" open={vi.fn()} />); fireEvent.click(screen.getByRole("button", { name: "Git" }));
  await screen.findByText(/В пространстве нет Git-репозиториев/);
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual(["list_git_repositories"]);
});

test.each(["список", "история"])("переключение ветки без подтверждения: %s", async source => {
  mockGit({ git_action: () => {
    if (source === "история") throw new Error("ветка занята другим рабочим деревом");
    return "Ветка переключена";
  } });
  await openGit();
  if (source === "список") choose("Текущая ветка", "feature");
  else {
    fireEvent.click(screen.getByRole("tab", { name: "История" }));
    fireEvent.click(screen.getByRole("button", { name: "feature" }));
    menu("Действия ветки feature", "Переключиться");
  }
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("git_action", { target, action: { kind: "switch", reference: "refs/heads/feature" } }));
  if (source === "история") await screen.findByText(/ветка занята другим рабочим деревом/);
  else await waitFor(() => expect(screen.getAllByText("Ветка переключена").length).toBeGreaterThan(0));
  await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "git_status")).toHaveLength(2));
});

test("флажок подготавливает только выбранный файл и после ошибки перечитывает индекс", async () => {
  mockGit({ stage_git_files: () => { throw new Error("index.lock уже существует"); } }); await openGit();
  fireEvent.click(screen.getByRole("checkbox", { name: "Включить в коммит one" }));
  await screen.findByText(/index.lock уже существует/);
  await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === "git_status")).toHaveLength(2));
  expect(invoke).toHaveBeenCalledWith("stage_git_files", { target, paths: ["one"] });
  expect(screen.getByRole("checkbox", { name: "Включить в коммит two" })).toBeTruthy();
});

test("подготовка фрагмента передаёт показанную версию и убирает устаревший diff", async () => {
  mockGit({ stage_git_hunk: () => { throw new Error("файл или индекс изменился; обновите diff"); } }); await openGit();
  fireEvent.click(screen.getByRole("button", { name: "Неподготовленные one" }));
  await screen.findByLabelText("Сравнение версий");
  fireEvent.click(screen.getByRole("button", { name: "Включить фрагмент 2 в коммит" }));
  await screen.findByText(/обновите diff/);
  await waitFor(() => expect(screen.getByRole("button", { name: "Включить фрагмент 2 в коммит" })).toBeTruthy());
  expect(invoke).toHaveBeenCalledWith("stage_git_hunk", { target, expected, hunk: 1 });
});

test("исключение из коммита сохраняет рабочий файл и вызывает снятие подготовки", async () => {
  mockGit({ git_status: () => status([change("one", "M", " ")]), unstage_git_files: () => null }); await openGit();
  fireEvent.click(screen.getByRole("checkbox", { name: "Исключить из коммита one" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("unstage_git_files", { target, paths: ["one"] }));
});

test("ошибка коммита сохраняет сообщение, отказ отправки показывает реальный результат", async () => {
  mockGit({ git_status: () => status([change("one", "M", " ")]), commit_git: () => { throw new Error("hook отклонил коммит"); }, git_action: () => { throw new Error("отправка отклонена"); } }); await openGit();
  fireEvent.change(screen.getByLabelText("Сообщение коммита"), { target: { value: "выбранные изменения" } });
  fireEvent.click(screen.getByRole("button", { name: "Создать коммит" }));
  await screen.findByText("Error: hook отклонил коммит");
  await waitFor(() => expect((screen.getByRole("button", { name: "Действия Git" }) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByLabelText("Сообщение коммита") as HTMLTextAreaElement).value).toBe("выбранные изменения");
  expect(invoke).toHaveBeenCalledWith("commit_git", { target, message: "выбранные изменения" });
  menu("Действия Git", "Отправить коммиты");
  expect(screen.queryByRole("dialog")).toBeNull();
  await screen.findByText("Error: отправка отклонена");
  expect(invoke).toHaveBeenCalledWith("git_action", { target, action: { kind: "push", remote: null, force: false } });
});

test("коммит и отправка не отправляют изменения после отказа коммита", async () => {
  mockGit({ git_status: () => status([change("one", "M", " ")]), commit_git: () => { throw new Error("hook rejected"); }, git_action: () => null }); await openGit();
  fireEvent.change(screen.getByLabelText("Сообщение коммита"), { target: { value: "изменения" } });
  menu("Действия коммита", "Коммит и отправка");
  expect(screen.queryByRole("dialog")).toBeNull();
  await screen.findByText(/hook rejected/);
  expect(vi.mocked(invoke).mock.calls.some(([c]) => c === "git_action")).toBe(false);
});

test.each([false, true])("отправка в upstream без окна, принудительная: %s", async force => {
  mockGit({ git_status: () => ({ ...status([change("one", "M", " ")]), remotes: ["other", "origin"], upstream: "origin/review/main" }), commit_git: () => "создан коммит", git_action: () => "отправлено" });
  await openGit();
  expect(screen.queryByText("Включена принудительная отправка", { exact: false })).toBeNull();
  if (force) menu("Действия коммита", "Принудительная отправка");
  fireEvent.change(screen.getByLabelText("Сообщение коммита"), { target: { value: "изменения" } });
  menu("Действия коммита", "Коммит и отправка");
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("git_action", { target, action: { kind: "push", remote: null, force } }));
  expect(vi.mocked(invoke).mock.calls.findIndex(([c]) => c === "commit_git")).toBeLessThan(vi.mocked(invoke).mock.calls.findIndex(([c]) => c === "git_action"));
  await waitFor(() => expect((screen.getByRole("button", { name: "Действия Git" }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.queryByText("Включена принудительная отправка", { exact: false })).toBeNull();
  if (force) menu("Действия Git", "Принудительная отправка");
  fireEvent.click(screen.getByRole("tab", { name: "История" }));
  fireEvent.click(screen.getByRole("button", { name: "Отправить коммиты" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([c, args]) => c === "git_action" && (args as any).action.kind === "push")).toHaveLength(2));
  expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === "git_action").map(([, args]) => args)).toEqual([
    { target, action: { kind: "push", remote: null, force } }, { target, action: { kind: "push", remote: null, force } },
  ]);
});

test("первая отправка выбирает единственный remote без окна", async () => {
  mockGit({ git_status: () => ({ ...status(), upstream: null }), git_action: () => "отправлено" }); await openGit();
  menu("Действия Git", "Отправить коммиты");
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("git_action", { target, action: { kind: "push", remote: "origin", force: false } }));
});

test.each([false, true])("без upstream несколько remote требуют выбора, с коммитом: %s", async withCommit => {
  mockGit({ git_status: () => ({ ...status([change("one", "M", " ")]), upstream: null, remotes: ["origin", "other"] }), commit_git: () => "создан коммит", git_action: () => "отправлено" }); await openGit();
  if (withCommit) {
    fireEvent.change(screen.getByLabelText("Сообщение коммита"), { target: { value: "изменения" } });
    menu("Действия коммита", "Коммит и отправка");
  } else menu("Действия Git", "Отправить коммиты");
  expect(invoke).not.toHaveBeenCalledWith("commit_git", expect.anything());
  expect(invoke).not.toHaveBeenCalledWith("git_action", expect.anything());
  choose("Удалённый репозиторий", "other");
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("checkbox", { name: "Принудительная отправка" }));
  confirm();
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("git_action", { target, action: { kind: "push", remote: "other", force: true } }));
});

test("конфликт показывает все версии, открывает вложенный файл и обновляется после подготовки", async () => {
  const open = vi.fn(); let resolved = false;
  mockGit({ list_git_repositories: () => ["nested"], git_status: () => status([{ ...change("file.txt", resolved ? "M" : "U", resolved ? " " : "U"), conflict: !resolved }]),
    git_versions: () => [{ name: "Наша версия", text: "наша" }, { name: "Входящая версия", text: "входящая" }, { name: "Общий предок", text: null }, { name: "Файл на диске", text: "результат" }],
    stage_git_files: () => { resolved = true; } });
  render(<Git workspaceId="group" open={open} />); fireEvent.click(screen.getByRole("button", { name: "Git" }));
  fireEvent.click(await screen.findByRole("button", { name: "Версии конфликта file.txt" }));
  expect((await screen.findByLabelText("Сравнение версий")).textContent).toBe("наша|входящая");
  choose("Версия слева", "Общий предок (отсутствует)");
  expect(screen.getByLabelText("Сравнение версий").textContent).toBe("|входящая");
  fireEvent.click(within(screen.getByLabelText("Конфликты Git")).getByRole("button", { name: "Редактировать file.txt" }));
  expect(open).toHaveBeenCalledWith("nested/file.txt");
  fireEvent.click(screen.getByRole("button", { name: "Подготовить результат file.txt" }));
  await waitFor(() => expect(screen.queryByLabelText("Конфликты Git")).toBeNull());
});

test("ошибка рабочей версии не мешает сравнению подготовленного текста", async () => {
  mockGit({ git_status: () => status([change("file.txt", "M", "M")]), git_versions: () => [...versions.slice(0, 2), { name: "Файл на диске", text: null, error: "двоичный файл" }] }); await openGit();
  menu("Действия файла file.txt", "Сравнить подготовленные изменения");
  expect((await screen.findByLabelText("Сравнение версий")).textContent).toBe("исходный|подготовленный");
  expect(screen.queryByRole("alert")).toBeNull();
  choose("Версия справа", "Файл на диске (недоступна)");
  expect(screen.getByRole("alert").textContent).toBe("Файл на диске: двоичный файл");
  choose("Версия справа", "Индекс Git"); expect(screen.queryByRole("alert")).toBeNull();
});

test("запоздавшее сравнение прежнего репозитория не подменяет новый контекст", async () => {
  let finish!: (value: unknown) => void;
  mockGit({ list_git_repositories: () => ["first", "second"], git_versions: () => new Promise(resolve => { finish = resolve; }) });
  render(<Git workspaceId="group" open={vi.fn()} />); fireEvent.click(screen.getByRole("button", { name: "Git" }));
  fireEvent.click(await screen.findByRole("button", { name: "Неподготовленные one" })); choose("Репозиторий", "second");
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("git_status", { target: { workspaceId: "group", repository: "second" } }));
  await act(async () => finish(versions)); expect(screen.queryByLabelText("Сравнение версий")).toBeNull();
});

test("откат файла выполняется только после подтверждения и передаёт снимок", async () => {
  mockGit({ discard_git_file: () => null }); await openGit();
  fireEvent.click(screen.getByRole("button", { name: "Неподготовленные one" }));
  await screen.findByLabelText("Сравнение версий");
  menu("Действия сравнения", "Откатить неподготовленные изменения…");
  expect(vi.mocked(invoke).mock.calls.some(([c]) => c === "discard_git_file")).toBe(false);
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Отмена" }));
  menu("Действия сравнения", "Откатить неподготовленные изменения…"); confirm();
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("discard_git_file", { target, expected }));
});

test("наборы файлов и черновик коммита сохраняются отдельно для репозитория", async () => {
  mockGit(); await openGit();
  fireEvent.change(screen.getByLabelText("Сообщение коммита"), { target: { value: "черновик" } });
  menu("Действия Git", "Создать набор изменений");
  fireEvent.change(screen.getByRole("textbox", { name: "Название" }), { target: { value: "Панель Git" } }); confirm();
  fireEvent.click(screen.getByRole("button", { name: "Неподготовленные one" })); await screen.findByLabelText("Сравнение версий"); menu("Действия файла one", "В набор «Панель Git»");
  const key = `yade.git:${JSON.stringify(["w", ""])}`;
  const saved = readGitDraft(key); expect(saved.message).toBe("черновик"); expect(saved.assignments.one).toBe(saved.lists[1].id);
  cleanup(); await openGit(); expect((screen.getByLabelText("Сообщение коммита") as HTMLTextAreaElement).value).toBe("черновик");
  expect(readGitDraft(`yade.git:${JSON.stringify(["other", ""])}`).message).toBe("");
});

test("черновик сообщения общий для пространств проекта и изолирован от других проектов", async () => {
  mockGit(); await openGit("w", "p");
  const message = () => (screen.getByLabelText("Сообщение коммита") as HTMLTextAreaElement).value;
  fireEvent.change(screen.getByLabelText("Сообщение коммита"), { target: { value: "Общий черновик\n\nОписание" } });
  menu("Действия Git", "Создать набор изменений");
  fireEvent.change(screen.getByRole("textbox", { name: "Название" }), { target: { value: "Локальный набор" } }); confirm();
  cleanup(); await openGit("worktree", "p");
  expect(message()).toBe("Общий черновик\n\nОписание");
  expect(screen.queryByText("Локальный набор")).toBeNull();
  fireEvent.change(screen.getByLabelText("Сообщение коммита"), { target: { value: "Обновлённый черновик" } });
  cleanup(); await openGit("other", "other-project");
  expect(message()).toBe("");
  cleanup(); await openGit("w", "p");
  expect(message()).toBe("Обновлённый черновик");
  fireEvent.change(screen.getByLabelText("Сообщение коммита"), { target: { value: "" } });
  cleanup(); await openGit("worktree", "p");
  expect(message()).toBe("");
});

test("существующий черновик сообщения восстанавливается и становится общим для проекта", async () => {
  const key = `yade.git:${JSON.stringify(["w", ""])}`;
  localStorage.setItem(key, JSON.stringify({ message: "Старый черновик", lists: [{ id: "default", name: "Изменения" }], assignments: {} }));
  mockGit(); await openGit("w", "p");
  expect((screen.getByLabelText("Сообщение коммита") as HTMLTextAreaElement).value).toBe("Старый черновик");
  cleanup(); await openGit("worktree", "p");
  expect((screen.getByLabelText("Сообщение коммита") as HTMLTextAreaElement).value).toBe("Старый черновик");
});

test("история показывает граф и сведения, фильтрует запрос и открывает версии коммита", async () => {
  mockGit({ git_revision_versions: () => versions.slice(0, 2) }); await openGit(); fireEvent.click(screen.getByRole("tab", { name: "История" }));
  await screen.findByRole("heading", { name: commit.subject });
  expect(screen.getByText("Синхронизировать строки.")).toBeTruthy();
  expect(document.querySelectorAll(".git-graph circle")).toHaveLength(1);
  fireEvent.change(screen.getByRole("textbox", { name: "Поиск коммитов" }), { target: { value: "сравнения" } });
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("git_history", { target, options: { reference: null, query: "сравнения", author: "", offset: 0 } }));
  fireEvent.click(await screen.findByRole("button", { name: "Показать изменения" }));
  await screen.findByLabelText("Сравнение версий");
  expect(invoke).toHaveBeenCalledWith("git_revision_versions", { target, reference: commit.hash, path: "src/Diff.tsx", base: null });
  expect(screen.queryByRole("button", { name: "Откатить неподготовленные изменения" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "История коммитов" }));
  await screen.findByRole("heading", { name: commit.subject });
});

test.each([true, false])("ветка создаётся от текущего коммита, переключение: %s", async checkout => {
  mockGit({ git_action: () => null }); await openGit();
  menu("Действия Git", "Новая ветка…");
  const dialog = within(screen.getByRole("dialog"));
  expect(dialog.queryByText("HEAD")).toBeNull();
  const toggle = dialog.getByRole("checkbox", { name: "Переключиться на новую ветку" }) as HTMLInputElement;
  expect(toggle.checked).toBe(true);
  if (!checkout) fireEvent.click(toggle);
  fireEvent.change(dialog.getByRole("textbox", { name: "Название" }), { target: { value: "feature/current" } }); confirm();
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("git_action", { target, action: { kind: "create_branch", start: "HEAD", name: "feature/current", checkout } }));
});

test.each([true, false])("ветка создаётся от выбранного коммита после ввода имени, переключение: %s", async checkout => {
  mockGit({ git_action: () => null }); await openGit(); fireEvent.click(screen.getByRole("tab", { name: "История" }));
  await screen.findByRole("heading", { name: commit.subject });
  menu(`Действия коммита ${commit.hash.slice(0, 7)}`, "Создать ветку…");
  expect(within(screen.getByRole("dialog")).getByText(commit.hash)).toBeTruthy();
  if (!checkout) fireEvent.click(screen.getByRole("checkbox", { name: "Переключиться на новую ветку" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Название" }), { target: { value: "feature/git" } }); confirm();
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("git_action", { target, action: { kind: "create_branch", start: commit.hash, name: "feature/git", checkout } }));
});

test("ошибка локального хранилища видна и повреждённый черновик не перезаписывается", async () => {
  const key = `yade.git:${JSON.stringify(["w", ""])}`; localStorage.setItem(key, "broken"); mockGit(); await openGit();
  expect(screen.getByRole("alert").textContent).toContain("Черновик Git не сохранён"); expect(localStorage.getItem(key)).toBe("broken");
});

test.each(["broken", "42"])("повреждённое общее сообщение не перезаписывается: %s", async value => {
  const key = `yade.git.message:${JSON.stringify(["p", ""])}`;
  localStorage.setItem(key, value); mockGit(); await openGit("w", "p");
  expect(screen.getByRole("alert").textContent).toContain("Черновик Git не сохранён");
  expect(localStorage.getItem(key)).toBe(value);
});

test("сравнение веток фиксирует оба коммита и вкладка не подменяет их рабочей копией", async () => {
  const base = "b".repeat(40);
  mockGit({ git_compare_branches: () => ({ hash: commit.hash, message: base, files: [{ path: "one", added: 1, deleted: 0 }] }), git_revision_versions: () => versions.slice(0, 2) });
  await openGit(); fireEvent.click(screen.getByRole("tab", { name: "История" }));
  fireEvent.click(screen.getByRole("button", { name: "feature" }));
  menu("Действия ветки feature", "Сравнить с текущей");
  const list = await screen.findByText(/файлов/, { selector: ".git-branch-comparison p" });
  fireEvent.click(within(list.parentElement!).getByRole("button", { name: /one/ }));
  await screen.findByLabelText("Сравнение версий");
  expect(invoke).toHaveBeenCalledWith("git_revision_versions", { target, reference: commit.hash, path: "one", base });
  fireEvent.click(screen.getByRole("tab", { name: "История коммитов" }));
  fireEvent.click(screen.getByRole("tab", { name: /one.*aaaaaaa/ }));
  await screen.findByLabelText("Сравнение версий");
  expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === "git_versions")).toHaveLength(0);
});

test("имена файлов не пересекаются со свойствами объекта распределения наборов", async () => {
  mockGit({ git_status: () => status([change("__proto__"), change("constructor")]) }); await openGit();
  expect(screen.getByRole("button", { name: "Неподготовленные __proto__" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Неподготовленные constructor" })).toBeTruthy();
});

test("Git дожидается сохранения редакторов перед операцией и не продолжает при ошибке", async () => {
  const flush = vi.fn(async () => {});
  mockGit({ stage_git_files: () => null });
  render(<Git workspaceId="w" open={vi.fn()} beforeOperation={flush} embedded />);
  await screen.findByRole("checkbox", { name: "Включить в коммит one" });
  let finish!: () => void;
  flush.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Включить в коммит one" }));
  expect(vi.mocked(invoke).mock.calls.some(([c]) => c === "stage_git_files")).toBe(false);
  await act(async () => finish());
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("stage_git_files", { target, paths: ["one"] }));
  await waitFor(() => expect((screen.getByRole("checkbox", { name: "Включить в коммит two" }) as HTMLInputElement).disabled).toBe(false));
  flush.mockRejectedValueOnce(new Error("черновик недоступен"));
  fireEvent.click(screen.getByRole("checkbox", { name: "Включить в коммит two" }));
  await screen.findByText(/черновик недоступен/);
  expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === "stage_git_files")).toHaveLength(1);
});

test("переход из файла коммита сохраняет поиск и выбранную строку истории", async () => {
  const second = { ...commit, hash: "b".repeat(40), subject: "Второе изменение" };
  mockGit({ git_history: () => ({ commits: [commit, second], hasMore: false }), git_commit_details: args => ({ hash: args.reference, message: args.reference === second.hash ? second.subject : commit.subject, files: [{ path: "one", added: 1, deleted: 0 }] }), git_revision_versions: () => versions.slice(0, 2) });
  await openGit(); fireEvent.click(screen.getByRole("tab", { name: "История" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Поиск коммитов" }), { target: { value: "изменение" } });
  fireEvent.click(await screen.findByRole("button", { name: /Второе изменение/ }));
  await screen.findByRole("heading", { name: second.subject });
  fireEvent.click(screen.getByRole("button", { name: "Показать изменения" })); await screen.findByLabelText("Сравнение версий");
  fireEvent.click(screen.getByRole("tab", { name: "История коммитов" }));
  expect(screen.getByRole("heading", { name: second.subject })).toBeTruthy();
  expect((screen.getByRole("textbox", { name: "Поиск коммитов" }) as HTMLInputElement).value).toBe("изменение");
});

test("смена режима не принимает запоздавшее сравнение рабочей копии", async () => {
  let finish!: (value: unknown) => void;
  mockGit({ git_versions: () => new Promise(resolve => { finish = resolve; }) }); await openGit();
  fireEvent.click(screen.getByRole("button", { name: "Неподготовленные one" }));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  fireEvent.click(screen.getByRole("tab", { name: "История" }));
  await screen.findByRole("heading", { name: commit.subject });
  await act(async () => finish(versions));
  expect(screen.queryByLabelText("Сравнение версий")).toBeNull();
  expect(screen.getByRole("heading", { name: commit.subject })).toBeTruthy();
});

test("граф связывает разветвление и слияние по родителям коммитов", () => {
  const commits = [
    { ...commit, hash: "merge", parents: ["main", "feature"] }, { ...commit, hash: "main", parents: ["root"] },
    { ...commit, hash: "feature", parents: ["root"] }, { ...commit, hash: "root", parents: [] },
  ];
  const graph = commitGraph(commits); expect(graph.map(row => row.column)).toEqual([0, 0, 1, 0]);
  expect(graph[0].edges).toEqual([{ from: 0, to: 0 }, { from: 0, to: 1 }]);
  expect(graph[2].edges).toContainEqual({ from: 1, to: 0 });
});

test("единый список не дублирует частично подготовленный файл и выбирает все файлы, включая новые", async () => {
  mockGit({ git_status: () => status([change("one", "M", "M"), change("two"), change("new", "?", "?")]), stage_git_files: () => null });
  await openGit();
  expect(screen.getAllByRole("button", { name: /^(Подготовленные|Неподготовленные) one$/ })).toHaveLength(1);
  expect((screen.getByRole("checkbox", { name: "Исключить из коммита one" }) as HTMLInputElement).indeterminate).toBe(true);
  const selectAll = screen.getByRole("checkbox", { name: "Включить все файлы" }) as HTMLInputElement;
  expect(selectAll.indeterminate).toBe(true);
  expect(screen.getByText("3 файла")).toBeTruthy();
  fireEvent.click(selectAll);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("stage_git_files", { target, paths: ["one", "two", "new"] }));
  expect(screen.getByRole("checkbox", { name: "Включить в коммит new" })).toBeTruthy();
});

test("после подготовки файла сравнение остаётся открытым на обновлённой версии индекса", async () => {
  let prepared = false;
  mockGit({ git_status: () => status([change("one", prepared ? "M" : " ", prepared ? " " : "M"), change("two")]), stage_git_files: () => { prepared = true; } });
  await openGit(); fireEvent.click(screen.getByRole("button", { name: "Неподготовленные one" }));
  await screen.findByLabelText("Сравнение версий");
  fireEvent.click(screen.getByRole("checkbox", { name: "Включить в коммит one" }));
  await waitFor(() => expect(screen.getByLabelText("Сравнение версий").textContent).toBe("исходный|подготовленный"));
  expect(screen.queryByText("Выберите файл")).toBeNull();
});

test("дополнение коммита загружает сообщение и передаёт проверяемый HEAD", async () => {
  mockGit({ git_status: () => status(), git_action: () => "Коммит дополнен" });
  await openGit(); menu("Действия Git", "Дополнить последний коммит");
  await waitFor(() => expect((screen.getByLabelText("Сообщение коммита") as HTMLTextAreaElement).value).toContain(commit.subject));
  fireEvent.click(screen.getByRole("button", { name: "Дополнить коммит" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("git_action", { target, action: { kind: "amend", reference: commit.hash, message: `${commit.subject}\n\nСинхронизировать строки.` } }));
});

test("успешные сообщения доступны из истории и восстанавливаются в поле коммита", async () => {
  mockGit({ git_status: () => status([change("one", "M", " ")]), commit_git: () => "Коммит создан" });
  await openGit();
  fireEvent.change(screen.getByLabelText("Сообщение коммита"), { target: { value: "Добавить сравнение" } });
  fireEvent.click(screen.getByRole("button", { name: "Создать коммит" }));
  await waitFor(() => expect((screen.getByLabelText("Сообщение коммита") as HTMLTextAreaElement).value).toBe(""));
  await waitFor(() => expect((screen.getByRole("button", { name: "История сообщений коммита" }) as HTMLButtonElement).disabled).toBe(false));
  menu("История сообщений коммита", "Добавить сравнение");
  expect((screen.getByLabelText("Сообщение коммита") as HTMLTextAreaElement).value).toBe("Добавить сравнение");
});

test("успешный коммит очищает общий черновик во всех пространствах проекта", async () => {
  mockGit({ git_status: () => status([change("one", "M", " ")]), commit_git: () => "Коммит создан" });
  await openGit("w", "p");
  fireEvent.change(screen.getByLabelText("Сообщение коммита"), { target: { value: "Общий черновик" } });
  cleanup(); await openGit("worktree", "p");
  fireEvent.click(screen.getByRole("button", { name: "Создать коммит" }));
  await waitFor(() => expect((screen.getByLabelText("Сообщение коммита") as HTMLTextAreaElement).value).toBe(""));
  cleanup(); await openGit("w", "p");
  expect((screen.getByLabelText("Сообщение коммита") as HTMLTextAreaElement).value).toBe("");
});

test("меню файла открывается правой кнопкой и управляется с клавиатуры", async () => {
  mockGit(); await openGit();
  const row = screen.getByRole("button", { name: "Неподготовленные one" }); row.focus();
  fireEvent.contextMenu(row, { clientX: 100, clientY: 100 });
  expect(screen.getByRole("menu", { name: "Действия файла one" })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Открыть в редакторе" }));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Включить файл целиком" }));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull(); expect(document.activeElement).toBe(row);
});
