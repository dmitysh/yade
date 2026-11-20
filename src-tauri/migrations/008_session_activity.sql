ALTER TABLE sessions ADD COLUMN last_activity_at INTEGER NOT NULL DEFAULT 0;

UPDATE sessions SET last_activity_at = COALESCE((
    SELECT MAX(activity.at) FROM (
        SELECT session_id, unixepoch(created_at) * 1000 AS at FROM messages
        UNION ALL
        SELECT r.session_id, unixepoch(e.created_at) * 1000 AS at
        FROM events e JOIN runs r ON r.id = e.run_id
    ) activity WHERE activity.session_id = sessions.id
), 0);

CREATE TRIGGER session_activity_created AFTER INSERT ON sessions BEGIN
    UPDATE sessions SET last_activity_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE id = NEW.id;
END;

CREATE TRIGGER session_activity_view_insert AFTER INSERT ON view_state BEGIN
    UPDATE sessions SET last_activity_at = MAX(last_activity_at, CAST(unixepoch('subsec') * 1000 AS INTEGER))
    WHERE id = (
        SELECT json_extract(tab.value, '$.sessionId')
        FROM json_each(NEW.value, '$.tabs') tab JOIN json_each(NEW.value, '$.activeTabs') active
        ON json_extract(tab.value, '$.id') = active.value
        WHERE active.key = json_extract(NEW.value, '$.workspaceId')
    );
END;

CREATE TRIGGER session_activity_view_update AFTER UPDATE OF value ON view_state BEGIN
    UPDATE sessions SET last_activity_at = MAX(last_activity_at, CAST(unixepoch('subsec') * 1000 AS INTEGER))
    WHERE id = (
        SELECT json_extract(tab.value, '$.sessionId')
        FROM json_each(NEW.value, '$.tabs') tab JOIN json_each(NEW.value, '$.activeTabs') active
        ON json_extract(tab.value, '$.id') = active.value
        WHERE active.key = json_extract(NEW.value, '$.workspaceId')
    );
END;

CREATE TRIGGER session_activity_message AFTER INSERT ON messages BEGIN
    UPDATE sessions SET last_activity_at = MAX(last_activity_at, CAST(unixepoch('subsec') * 1000 AS INTEGER))
    WHERE id = NEW.session_id;
END;

CREATE TRIGGER session_activity_event AFTER INSERT ON events BEGIN
    UPDATE sessions SET last_activity_at = MAX(last_activity_at, CAST(unixepoch('subsec') * 1000 AS INTEGER))
    WHERE id = (SELECT session_id FROM runs WHERE id = NEW.run_id);
END;

CREATE TRIGGER session_activity_draft_insert AFTER INSERT ON drafts BEGIN
    UPDATE sessions SET last_activity_at = MAX(last_activity_at, CAST(unixepoch('subsec') * 1000 AS INTEGER))
    WHERE id = NEW.session_id;
END;

CREATE TRIGGER session_activity_draft_update AFTER UPDATE OF body ON drafts
WHEN NEW.body IS NOT OLD.body BEGIN
    UPDATE sessions SET last_activity_at = MAX(last_activity_at, CAST(unixepoch('subsec') * 1000 AS INTEGER))
    WHERE id = NEW.session_id;
END;
