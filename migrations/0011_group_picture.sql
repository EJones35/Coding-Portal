-- Groups get their own picture, stored inline in D1 exactly like a member's.
-- Bounded by the same rules: a validated PNG, JPEG, WebP or GIF well under
-- 350 KB, served only to a signed-in member through an authenticated endpoint.
ALTER TABLE portal_groups ADD COLUMN picture_data TEXT;
