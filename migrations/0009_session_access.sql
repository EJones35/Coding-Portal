-- Lock a session to specific users and/or specific groups.
-- A session with no rows in either table is open to everyone. Deriving
-- "restricted" from the presence of rows means there is no flag that can drift
-- out of step with the rows it is supposed to describe.
CREATE TABLE session_access (
  session_id TEXT NOT NULL REFERENCES coding_sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (session_id, user_id)
);

CREATE INDEX idx_session_access_user ON session_access(user_id);

CREATE TABLE session_group_access (
  session_id TEXT NOT NULL REFERENCES coding_sessions(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES portal_groups(id) ON DELETE CASCADE,
  granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (session_id, group_id)
);

CREATE INDEX idx_session_group_access_group ON session_group_access(group_id);
