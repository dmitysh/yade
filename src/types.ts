export interface Group { id: string; name: string; path: string | null }
export interface Project { id: string; groupId: string | null; name: string; path: string; kind: string; preparationCommand: string | null; lastActivityAt?: number }
export interface Workspace {
  id: string; projectId: string | null; groupId: string | null; name: string;
  path: string; kind: string; archived: boolean; deleted: boolean;
  sourceRef: string | null; sourceCommit: string | null; gitRef: string | null; operationState: string; operationError: string | null;
  preparationCommand: string | null; preparationState: string; preparationOutput: string;
}
export interface Session {
  id: string; workspaceId: string; executor: string; title: string; state: string;
  externalId?: string | null;
  lastActivityAt?: number;
}
export interface TerminalInfo {
  id: string; workspaceId: string; state: string; exitCode: number | null; error: string | null;
  lastActivityAt?: number;
  execution?: { executor: string; state: string; title?: string | null } | null;
  shellToken?: string | null;
}
export interface Context { workspaceId: string; sessionId: string; runId: string }
export interface Message { sequence: number; sessionId: string; runId: string | null; role: string; body: string }
export interface RunEvent { sequence: number; context: Context; kind: string; payload: Record<string, any> }
export interface ConversationData {
  session: Session; context: Context | null; messages: Message[]; messageEvents: Record<number, number>; events: RunEvent[]; requests: RunEvent[];
  canStop: boolean; olderMessages: boolean; olderEvents: boolean; draft: string;
}
export interface Tab { id: string; workspaceId: string; sessionId: string | null }
export interface View {
  projectId: string | null; workspaceId: string | null; tabs: Tab[];
  activeTabs: Record<string, string>; sidebarWidth: number;
}
export interface Snapshot {
  screenReaderEnabled?: boolean;
  groups: Group[]; projects: Project[]; workspaces: Workspace[]; sessions: Session[]; view: View;
  terminals?: TerminalInfo[];
}
export interface Draft { id: string; workspaceId: string; sessionId: string | null; path: string | null; body: string; baseVersion: string | null }
export interface DeletionCheck {
  workspaceId: string; path: string; kind: string; pathExists: boolean; registered: boolean;
  branch: string | null; head: string | null; drafts: Draft[]; changes: string; unmerged: string;
}
export interface FileDocument { path: string; body: string; base: string; disk: string | null; diskError?: string }
export interface FileEntry { path: string; name: string; directory: boolean }
export interface FileMatch { path: string; line: number; column: number; text: string; matched?: string }
export interface GitTarget { workspaceId: string; repository: string }
export interface GitChange { path: string; originalPath: string | null; index: string; worktree: string; conflict: boolean }
export interface GitStatus { reference: string; changes: GitChange[]; upstream: string | null; ahead: number; behind: number; remotes: string[]; operation: string | null }
export interface GitDiff { path: string; index: string; worktree: string; patch: string; hunks: string[] }
export interface GitVersion { name: string; text: string | null; error?: string }
export interface GitBranch { name: string; reference: string; kind: "local" | "remote" | "tag"; current: boolean; upstream: string }
export interface GitCommit { hash: string; parents: string[]; author: string; email: string; time: string; refs: string; subject: string }
export interface GitHistory { commits: GitCommit[]; hasMore: boolean }
export interface GitCommitDetails { hash: string; message: string; files: { path: string; added: number | null; deleted: number | null }[] }
export interface GitStash { reference: string; hash: string; message: string }
