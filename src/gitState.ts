import type { GitCommit } from "./types";

export interface ChangeList { id: string; name: string }
export interface GitDraft { message: string; lists: ChangeList[]; assignments: Record<string, string>; messages?: string[] }
export const emptyGitDraft: GitDraft = { message: "", lists: [{ id: "default", name: "Изменения" }], assignments: {} };

export function readGitDraft(key: string, messageKey?: string): GitDraft {
  const value = JSON.parse(localStorage.getItem(key) ?? "null") ?? emptyGitDraft;
  if (typeof value.message !== "string" || !Array.isArray(value.lists) || !value.lists.length
    || !value.lists.some((list: ChangeList) => list.id === "default")
    || !value.lists.every((list: ChangeList) => list && typeof list.id === "string" && typeof list.name === "string")
    || !value.assignments || typeof value.assignments !== "object" || Array.isArray(value.assignments)
    || !Object.values(value.assignments).every(id => typeof id === "string" && value.lists.some((list: ChangeList) => list.id === id))
    || (value.messages !== undefined && (!Array.isArray(value.messages) || !value.messages.every((message: unknown) => typeof message === "string")))) {
    throw new Error("сохранённый черновик Git повреждён");
  }
  if (!messageKey) return value;
  const message = JSON.parse(localStorage.getItem(messageKey) ?? "null");
  if (message !== null && typeof message !== "string") throw new Error("сохранённое сообщение коммита повреждено");
  return { ...value, message: message ?? value.message };
}

export function commitGraph(commits: GitCommit[]) {
  const lanes: string[] = [];
  const visible = new Set(commits.map(commit => commit.hash));
  return commits.map(commit => {
    let column = lanes.indexOf(commit.hash);
    if (column < 0) { column = lanes.length; lanes.push(commit.hash); }
    const before = [...lanes];
    lanes.splice(column, 1);
    for (const parent of [...commit.parents].reverse().filter(hash => visible.has(hash))) {
      if (!lanes.includes(parent)) lanes.splice(column, 0, parent);
    }
    return { column, width: Math.max(before.length, lanes.length, 1), edges: before.flatMap((hash, from) => {
      const targets = hash === commit.hash ? commit.parents.filter(hash => visible.has(hash)) : [hash];
      return targets.map(hash => ({ from, to: lanes.indexOf(hash) }));
    }) };
  });
}
