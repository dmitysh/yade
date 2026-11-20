CREATE TABLE project_groups (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT
);
CREATE TABLE projects (
    id TEXT PRIMARY KEY, group_id TEXT REFERENCES project_groups(id),
    name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK(kind IN ('folder', 'repository'))
);
CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id),
    group_id TEXT REFERENCES project_groups(id), name TEXT NOT NULL,
    path TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('folder', 'worktree')),
    source_ref TEXT, git_ref TEXT, archived INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    CHECK ((project_id IS NOT NULL) != (group_id IS NOT NULL))
);
CREATE TABLE sessions (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    executor TEXT NOT NULL CHECK(executor IN ('codex', 'claude')),
    external_id TEXT, title TEXT NOT NULL, state TEXT NOT NULL
);
CREATE TABLE runs (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
    state TEXT NOT NULL
);
CREATE TABLE messages (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT REFERENCES runs(id),
    role TEXT NOT NULL, body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id), kind TEXT NOT NULL,
    payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE drafts (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    session_id TEXT REFERENCES sessions(id), path TEXT,
    body TEXT NOT NULL, base_version TEXT,
    CHECK ((session_id IS NOT NULL AND path IS NULL) OR
           (session_id IS NULL AND path IS NOT NULL AND base_version IS NOT NULL))
);
CREATE TABLE view_state (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE processes (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
    pid INTEGER NOT NULL, process_group INTEGER NOT NULL, state TEXT NOT NULL
);
CREATE INDEX messages_session ON messages(session_id, sequence);
CREATE INDEX events_run ON events(run_id, sequence);
CREATE INDEX sessions_workspace ON sessions(workspace_id);
