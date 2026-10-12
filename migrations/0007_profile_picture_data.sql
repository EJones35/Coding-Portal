-- Store small validated profile pictures in D1; no external object storage required.
ALTER TABLE users ADD COLUMN profile_picture_data TEXT;

