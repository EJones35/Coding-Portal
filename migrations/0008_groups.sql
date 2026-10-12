-- Administrator-defined groups, so members can be organised and assigned.
-- Named `portal_groups` rather than `groups`: GROUPS is a SQLite window-frame
-- keyword and there is no reason to make the parser work for us.
CREATE TABLE portal_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_portal_groups_name
  ON portal_groups(name COLLATE NOCASE);

CREATE TABLE group_members (
  group_id TEXT NOT NULL REFERENCES portal_groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX idx_group_members_user ON group_members(user_id);
