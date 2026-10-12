-- Why an account is suspended or pending deletion, so the member can be told
-- when they try to sign in instead of just bouncing back to a signed-out page.
ALTER TABLE users ADD COLUMN status_reason TEXT;
