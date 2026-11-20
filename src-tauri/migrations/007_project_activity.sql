ALTER TABLE projects ADD COLUMN last_activity_at INTEGER NOT NULL DEFAULT 0;

UPDATE projects SET last_activity_at = COALESCE((
    SELECT MAX(activity.at) FROM (
        SELECT w.project_id, unixepoch(m.created_at) * 1000 AS at
        FROM messages m JOIN sessions s ON s.id = m.session_id
        JOIN workspaces w ON w.id = s.workspace_id
        UNION ALL
        SELECT w.project_id, unixepoch(e.created_at) * 1000 AS at
        FROM events e JOIN runs r ON r.id = e.run_id
        JOIN sessions s ON s.id = r.session_id JOIN workspaces w ON w.id = s.workspace_id
    ) activity WHERE activity.project_id = projects.id
), 0);

CREATE TRIGGER project_activity_created AFTER INSERT ON projects BEGIN
    UPDATE projects SET last_activity_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE id = NEW.id;
END;

CREATE TRIGGER project_activity_view_insert AFTER INSERT ON view_state BEGIN
    UPDATE projects SET last_activity_at = MAX(last_activity_at, CAST(unixepoch('subsec') * 1000 AS INTEGER))
    WHERE id = json_extract(NEW.value, '$.projectId');
END;

CREATE TRIGGER project_activity_view_update AFTER UPDATE OF value ON view_state BEGIN
    UPDATE projects SET last_activity_at = MAX(last_activity_at, CAST(unixepoch('subsec') * 1000 AS INTEGER))
    WHERE id = json_extract(NEW.value, '$.projectId');
END;

CREATE TRIGGER project_activity_message AFTER INSERT ON messages BEGIN
    UPDATE projects SET last_activity_at = MAX(last_activity_at, CAST(unixepoch('subsec') * 1000 AS INTEGER))
    WHERE id = (SELECT w.project_id FROM workspaces w JOIN sessions s ON s.workspace_id = w.id WHERE s.id = NEW.session_id);
END;

CREATE TRIGGER project_activity_event AFTER INSERT ON events BEGIN
    UPDATE projects SET last_activity_at = MAX(last_activity_at, CAST(unixepoch('subsec') * 1000 AS INTEGER))
    WHERE id = (SELECT w.project_id FROM workspaces w JOIN sessions s ON s.workspace_id = w.id JOIN runs r ON r.session_id = s.id WHERE r.id = NEW.run_id);
END;

CREATE TRIGGER project_activity_draft_insert AFTER INSERT ON drafts BEGIN
    UPDATE projects SET last_activity_at = MAX(last_activity_at, CAST(unixepoch('subsec') * 1000 AS INTEGER))
    WHERE id = (SELECT project_id FROM workspaces WHERE id = NEW.workspace_id);
END;

CREATE TRIGGER project_activity_draft_update AFTER UPDATE OF body, base_version ON drafts
WHEN NEW.body IS NOT OLD.body OR NEW.base_version IS NOT OLD.base_version BEGIN
    UPDATE projects SET last_activity_at = MAX(last_activity_at, CAST(unixepoch('subsec') * 1000 AS INTEGER))
    WHERE id = (SELECT project_id FROM workspaces WHERE id = NEW.workspace_id);
END;
