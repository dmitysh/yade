CREATE TABLE language_files (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    root TEXT NOT NULL,
    path TEXT NOT NULL,
    PRIMARY KEY (workspace_id, root, path)
);
