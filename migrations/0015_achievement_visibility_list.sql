-- The achievement visibility tables become a pure list of who CAN see an
-- achievement, instead of a list that meant "can see" in one mode and "cannot
-- see" in the other.
--
-- Until now `mode = 'everyone'` meant "everyone except the people and groups
-- marked invisible", so a stored visible = 0 was a hide. That reading is gone:
-- unchecking now deletes the row, and an achievement set to everyone carries no
-- list at all. So two kinds of row are now dead weight:
--
--   1. visible = 0 anywhere. It restricts nothing under the new rules, so it
--      holds a fact nobody can act on.
--   2. any row belonging to an achievement whose mode is 'everyone'. The table
--      then restricts nothing, and leaving it would make a stale list spring
--      back to life the moment that achievement was narrowed to "specific
--      people".
--
-- Both deletes are semantically no-ops against the new rules; they exist so
-- nothing on disk can be misread later. Checked on production before applying:
-- 3 user rows, 3 group rows, none of them hidden, all against everyone-mode
-- achievements - so this clears six rows that already did nothing.
DELETE FROM achievement_user_visibility WHERE visible = 0;
DELETE FROM achievement_group_visibility WHERE visible = 0;

DELETE FROM achievement_user_visibility
WHERE achievement_id IN (SELECT id FROM achievements WHERE mode = 'everyone');

DELETE FROM achievement_group_visibility
WHERE achievement_id IN (SELECT id FROM achievements WHERE mode = 'everyone');
