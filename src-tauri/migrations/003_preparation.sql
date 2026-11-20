ALTER TABLE projects ADD COLUMN preparation_command TEXT;
ALTER TABLE workspaces ADD COLUMN preparation_command TEXT;
ALTER TABLE workspaces ADD COLUMN preparation_state TEXT NOT NULL DEFAULT 'skipped';
ALTER TABLE workspaces ADD COLUMN preparation_output TEXT NOT NULL DEFAULT '';
ALTER TABLE processes RENAME TO old_processes;
CREATE TABLE processes (
    id TEXT PRIMARY KEY, run_id TEXT REFERENCES runs(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    pid INTEGER NOT NULL, process_group INTEGER NOT NULL, state TEXT NOT NULL
);
INSERT INTO processes(id,run_id,workspace_id,pid,process_group,state)
    SELECT p.id,p.run_id,s.workspace_id,p.pid,p.process_group,p.state
    FROM old_processes p JOIN runs r ON r.id=p.run_id JOIN sessions s ON s.id=r.session_id;
DROP TABLE old_processes;
