import { expect, test, vi } from "vitest";
import { openFileLink, resolveFileLink } from "./fileLinks";

test.each([
  ["src/App.tsx", { path: "src/App.tsx" }],
  ["./src/../README.md", { path: "README.md" }],
  ["/project/src/App.tsx:12:3", { path: "src/App.tsx", line: 12, column: 3 }],
  ["src/App.tsx:12", { path: "src/App.tsx", line: 12, column: 1 }],
  ["src/App.tsx#L12C3", { path: "src/App.tsx", line: 12, column: 3 }],
  ["src/App.tsx#L12", { path: "src/App.tsx", line: 12, column: 1 }],
  ["src/App.tsx#L12-L18", { path: "src/App.tsx", line: 12, column: 1 }],
  ["file:///project/src/App.tsx#L12", { path: "src/App.tsx", line: 12, column: 1 }],
  ["file://localhost/project/src/App.tsx:12:3", { path: "src/App.tsx", line: 12, column: 3 }],
  ["docs/мой%20файл.md", { path: "docs/мой файл.md" }],
  ["file:///project/docs/%D1%84%D0%B0%D0%B9%D0%BB.md", { path: "docs/файл.md" }],
])("ссылка %s разрешается внутри пространства", (href, expected) => {
  expect(resolveFileLink(href, "/project/")).toEqual(expected);
});

test.each([
  "", "#L12", "../other/src/App.tsx", "/project-copy/src/App.tsx", "/other/src/App.tsx",
  "/project/../../etc/passwd", "%2e%2e/secret.txt", "/project/.git/config", "~/project/src/App.tsx",
  "file://remote/project/src/App.tsx", "file:///other/src/App.tsx", "//remote/project/src/App.tsx",
  "file:///project/src/App.tsx?query=test",
  "https://example.org/src/App.tsx", "https://example.org/src/App.tsx:12", "javascript:alert(1)",
  "data:text/html,test", "src/App.tsx?raw=1", "src/App.tsx#other", "src/%ZZ.ts", "src/%00.ts",
  "src/App.tsx:0", "src/App.tsx:12:0", "src/App.tsx:999999999999999999999",
])("ссылка %s не становится переходом в редактор", href => {
  expect(resolveFileLink(href, "/project")).toBeNull();
});

test("повторные переходы к строке дают редактору новый запрос", async () => {
  const open = vi.fn(async () => {});
  await openFileLink({ path: "src/App.tsx", line: 12, column: 3 }, open);
  await openFileLink({ path: "src/App.tsx", line: 12, column: 3 }, open);
  expect(open.mock.calls[0]).toEqual(["src/App.tsx", { line: 12, column: 3, request: expect.any(Number) }]);
  expect(open.mock.calls[1]).not.toEqual(open.mock.calls[0]);
});

test("ссылки другого добавленного пространства сохраняют его идентификатор, чужие пути отклоняются", async () => {
  const workspaces = [{ id: "other", path: "/other" }, { id: "nested", path: "/other/nested" }];
  expect(resolveFileLink("src/App.tsx:12", "/project", workspaces)).toEqual({ path: "src/App.tsx", line: 12, column: 1 });
  expect(resolveFileLink("/other/src/App.tsx:12:3", "/project", workspaces)).toEqual({ path: "src/App.tsx", line: 12, column: 3, workspaceId: "other" });
  expect(resolveFileLink("file:///other/nested/App.tsx#L12", "/project", workspaces)).toEqual({ path: "App.tsx", line: 12, column: 1, workspaceId: "nested" });
  for (const href of ["/other-copy/App.tsx", "/unknown/App.tsx", "/other/.git/config", "/other/../unknown/App.tsx"]) {
    expect(resolveFileLink(href, "/project", workspaces)).toBeNull();
  }
  const open = vi.fn(async () => {});
  await openFileLink(resolveFileLink("/other/src/App.tsx:12:3", "/project", workspaces)!, open);
  expect(open).toHaveBeenCalledWith("src/App.tsx", { line: 12, column: 3, request: expect.any(Number) }, "other");
});
