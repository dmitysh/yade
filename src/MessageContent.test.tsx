// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import MessageContent from "./MessageContent";
import { AppearanceProvider, appearanceKey } from "./appearance";

afterEach(() => { cleanup(); localStorage.clear(); });

const paymentTable = [
  "| Значение | Тип оплаты |",
  "| --- | --- |",
  "| `pod`, `marketplace-pod` | Постоплата |",
  "| `cod`, `marketplace-cod` | Постоплата |",
  "| `prepaid`, `marketplace-deal` | Предоплата |",
  "| Неизвестное значение | Пустая строка, на экране `-` |",
].join("\n");

test("таблица Markdown внутри списка отображается строками и ячейками с кодом", () => {
  render(<MessageContent body={`3. Значение определяется по \`Order.Workflow\` — GetPaymentType:\n\n${paymentTable.split("\n").map(line => `   ${line}`).join("\n")}`} />);
  const table = screen.getByRole("table");
  expect(table.querySelectorAll("th")).toHaveLength(2);
  expect(table.querySelectorAll("tbody tr")).toHaveLength(4);
  expect(table.querySelectorAll("td")).toHaveLength(8);
  expect(table.querySelector("code")?.textContent).toBe("pod");
  expect(table.closest("li")).not.toBeNull();
});

test("режим исходного текста сохраняет разметку таблицы", () => {
  localStorage.setItem(appearanceKey, JSON.stringify({ chatFormat: "source" }));
  const { container } = render(<AppearanceProvider><MessageContent body={paymentTable} /></AppearanceProvider>);
  expect(screen.queryByRole("table")).toBeNull();
  expect(container.querySelector(".message-source")?.textContent).toBe(paymentTable);
});

test.each(["src/App.tsx:12:3", "/project/src/App.tsx#L12C3", "file:///project/src/App.tsx:12:3"])(
  "ссылка сообщения %s открывает файл в редакторе", href => {
    const openFile = vi.fn(async () => {});
    render(<MessageContent body={`[Открыть код](${href})`} workspacePath="/project" openFile={openFile} />);
    const link = screen.getByRole("link", { name: "Открыть код" });
    expect(link.getAttribute("target")).toBeNull();
    expect(fireEvent.click(link)).toBe(false);
    expect(openFile).toHaveBeenCalledWith("src/App.tsx", { line: 12, column: 3, request: expect.any(Number) });
  },
);

test("кодированный путь с пробелом открывается без изменения подписи ссылки", () => {
  const openFile = vi.fn(async () => {});
  render(<MessageContent body="[мой файл](docs/мой%20файл.md)" workspacePath="/project" openFile={openFile} />);
  fireEvent.click(screen.getByRole("link", { name: "мой файл" }));
  expect(openFile).toHaveBeenCalledWith("docs/мой файл.md", undefined);
});

test("внешние и чужие ссылки не открывают одноимённый файл проекта, опасные схемы отфильтрованы", () => {
  const openFile = vi.fn(async () => {});
  render(<MessageContent body={"[Сайт](https://example.org/src/App.tsx)\n\n[Другой проект](/other/src/App.tsx)\n\n[Опасная ссылка](javascript:alert%281%29)"} workspacePath="/project" openFile={openFile} />);
  expect(screen.getByRole("link", { name: "Сайт" }).getAttribute("target")).toBe("_blank");
  fireEvent.click(screen.getByRole("link", { name: "Другой проект" }));
  expect(openFile).not.toHaveBeenCalled();
  expect(screen.getByText("Опасная ссылка").getAttribute("href")).toBe("");
});

test("ошибка открытия файла показана рядом с сообщением", async () => {
  render(<MessageContent body="[Код](src/App.tsx)" workspacePath="/project" openFile={async () => { throw new Error("Не удалось сохранить вкладку"); }} />);
  fireEvent.click(screen.getByRole("link", { name: "Код" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Не удалось сохранить вкладку");
});

test("ссылка в другой добавленный проект открывается с его идентификатором", () => {
  const openFile = vi.fn(async () => {});
  render(<MessageContent body="[Код](file:///other/src/App.tsx#L12C3)" workspacePath="/project"
    fileWorkspaces={[{ id: "other", path: "/other" }]} openFile={openFile} />);
  fireEvent.click(screen.getByRole("link", { name: "Код" }));
  expect(openFile).toHaveBeenCalledWith("src/App.tsx", { line: 12, column: 3, request: expect.any(Number) }, "other");
});
