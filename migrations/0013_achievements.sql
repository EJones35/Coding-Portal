-- Achievements, who has earned them, and who may see them.
--
-- Visibility is deliberately two tables rather than one with nullable
-- foreign keys: SQLite treats NULLs as distinct in a primary key, so a
-- single table keyed on (achievement, user, group) could hold duplicate rows
-- for the same pair of NULLs and the uniqueness guarantee would be an illusion.
--
-- Semantics:
--   mode = 'everyone'    - every member can see it, except anyone explicitly
--                          hidden by a visible = 0 row.
--   mode = 'restricted'  - only people and groups explicitly listed with
--                          visible = 1 can see it.
-- A row with visible = 1 in 'everyone' mode simply records an explicit show.

CREATE TABLE achievements (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'everyone' CHECK (mode IN ('everyone', 'restricted')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_achievements_name ON achievements(name COLLATE NOCASE);

CREATE TABLE achievement_awards (
  achievement_id TEXT NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (achievement_id, user_id)
);

CREATE INDEX idx_achievement_awards_user ON achievement_awards(user_id);

CREATE TABLE achievement_user_visibility (
  achievement_id TEXT NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  visible INTEGER NOT NULL CHECK (visible IN (0, 1)),
  PRIMARY KEY (achievement_id, user_id)
);

CREATE TABLE achievement_group_visibility (
  achievement_id TEXT NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES portal_groups(id) ON DELETE CASCADE,
  visible INTEGER NOT NULL CHECK (visible IN (0, 1)),
  PRIMARY KEY (achievement_id, group_id)
);
