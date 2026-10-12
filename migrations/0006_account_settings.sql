-- Preserve session history while allowing permanent account deletion.
CREATE TABLE coding_sessions_new (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '',
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  location TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO coding_sessions_new (id, title, description, starts_at, ends_at, location, status, created_by, created_at, updated_at)
SELECT id, title, description, starts_at, ends_at, location, status, created_by, created_at, updated_at FROM coding_sessions;

CREATE TABLE session_attendance_new (
  session_id TEXT NOT NULL REFERENCES coding_sessions_new(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'present' CHECK (status IN ('present', 'absent', 'late', 'excused')),
  marked_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  marked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notes TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (session_id, user_id)
);
INSERT INTO session_attendance_new (session_id, user_id, status, marked_by, marked_at, notes)
SELECT session_id, user_id, status, marked_by, marked_at, notes FROM session_attendance;

DROP TABLE session_attendance;
DROP TABLE coding_sessions;
ALTER TABLE coding_sessions_new RENAME TO coding_sessions;
ALTER TABLE session_attendance_new RENAME TO session_attendance;
CREATE INDEX idx_coding_sessions_starts_at ON coding_sessions(starts_at);
CREATE INDEX idx_coding_sessions_status ON coding_sessions(status);
CREATE INDEX idx_session_attendance_user ON session_attendance(user_id);
