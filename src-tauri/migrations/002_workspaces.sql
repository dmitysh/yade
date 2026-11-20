ALTER TABLE workspaces ADD COLUMN operation_state TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE workspaces ADD COLUMN operation_error TEXT;
CREATE UNIQUE INDEX active_worktree_path ON workspaces(path) WHERE kind='worktree' AND deleted=0;
