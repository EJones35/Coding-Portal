CREATE TABLE coding_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '',
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  location TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_coding_sessions_starts_at
  ON coding_sessions(starts_at);

CREATE INDEX idx_coding_sessions_status
  ON coding_sessions(status);

CREATE TABLE session_attendance (
  session_id TEXT NOT NULL REFERENCES coding_sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'present'
    CHECK (status IN ('present', 'absent', 'late', 'excused')),
  marked_by TEXT NOT NULL REFERENCES users(id),
  marked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notes TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (session_id, user_id)
);

CREATE INDEX idx_session_attendance_user
  ON session_attendance(user_id);
