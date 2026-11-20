import type { FileLocation } from "./CodeEditor";
import type { Workspace } from "./types";

export interface FileLinks {
  workspacePath?: string;
  fileWorkspaces?: Pick<Workspace, "id" | "path">[];
  openFile?: (path: string, location?: FileLocation, workspaceId?: string) => Promise<void>;
}
export interface FileLink { path: string; line?: number; column?: number; workspaceId?: string }

export function resolveFileLink(href: string, workspacePath: string, fileWorkspaces: FileLinks["fileWorkspaces"] = []): FileLink | null {
  if (!href || href.startsWith("#") || href.startsWith("//")) return null;
  let path = href;
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path);
      if ((url.hostname && url.hostname !== "localhost") || url.search) return null;
      path = url.pathname + url.hash;
    } catch { return null; }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/:\d+(?::\d+)?$/.test(path)) return null;
  const fragment = /#L?(\d+)(?:C(\d+)|-L?\d+)?$/i.exec(path);
  if (fragment) path = path.slice(0, fragment.index);
  else if (path.includes("#")) return null;
  const suffix = /:(\d+)(?::(\d+))?$/.exec(path);
  if (suffix) path = path.slice(0, suffix.index);
  try { path = decodeURIComponent(path); } catch { return null; }
  if (!path || /[\x00-\x1f\x7f:?\\]/.test(path) || path.startsWith("~")) return null;
  // shortcut: относительные пути считаются от корня пространства; учитывать cwd при добавлении уведомлений оболочки.
  let root = workspacePath.replace(/\/+$/, "");
  const parts: string[] = [];
  for (const part of (path.startsWith("/") ? path : `${root}/${path}`).split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  const absolute = "/" + parts.join("/");
  let workspaceId: string | undefined;
  if (!absolute.startsWith(root + "/")) {
    const target = fileWorkspaces.filter(item => absolute.startsWith(item.path.replace(/\/+$/, "") + "/"))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!target) return null;
    root = target.path.replace(/\/+$/, "");
    workspaceId = target.id;
  }
  const relative = absolute.slice(root.length + 1);
  if (!relative || relative.split("/").includes(".git")) return null;
  const position = fragment ?? suffix;
  const line = position ? Number(position[1]) : undefined;
  const column = position?.[2] ? Number(position[2]) : undefined;
  if ((line !== undefined && (!Number.isSafeInteger(line) || line < 1))
    || (column !== undefined && (!Number.isSafeInteger(column) || column < 1))) return null;
  return { path: relative, ...(line === undefined ? {} : { line, column: column ?? 1 }), ...(workspaceId ? { workspaceId } : {}) };
}

export function openFileLink(link: FileLink, open: NonNullable<FileLinks["openFile"]>) {
  const location = link.line === undefined ? undefined
    : { line: link.line, column: link.column ?? 1, request: Date.now() + Math.random() };
  return link.workspaceId ? open(link.path, location, link.workspaceId) : open(link.path, location);
}
