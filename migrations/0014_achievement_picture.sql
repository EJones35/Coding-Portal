-- Achievement pictures, replacing the typed text icon.
--
-- The icon column existed as a placeholder for exactly this, and typing a
-- character into it was never a good answer: no real badge artwork, and an
-- arbitrary glyph to guess at. Stored and served exactly like a member's or a
-- group's picture - validated on signature, capped at 350 KB, served only to a
-- signed-in member through an authenticated endpoint, and versioned by a fresh
-- random token so a replacement can never be served from a stale decode.
ALTER TABLE achievements ADD COLUMN picture_data TEXT;
ALTER TABLE achievements ADD COLUMN picture_version TEXT;
