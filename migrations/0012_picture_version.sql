-- A dedicated version token for the stored picture.
--
-- Deriving a version from updated_at plus the image's byte length is not
-- airtight: updated_at only has one-second resolution, and two different
-- pictures of the same length uploaded in the same second produce the same
-- URL. The browser then reuses its already-decoded image and the new picture
-- never appears - the exact failure this whole mechanism exists to prevent.
--
-- A fresh random token is written on every picture change, so the URL is
-- different every time by construction.
ALTER TABLE users ADD COLUMN picture_version TEXT;
ALTER TABLE portal_groups ADD COLUMN picture_version TEXT;
