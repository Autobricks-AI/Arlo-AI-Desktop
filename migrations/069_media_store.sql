-- Files out of the database, and the same file stored once.
--
-- An unbounded `bytea` column is how a database fills up without anybody adding a record.
-- Attachments dominate it, and most of that is the same file over and over: one brochure sent
-- to every customer who asks is one brochure, stored once per conversation.
--
-- Nothing was wrong with the code that wrote them. `deliver()` files a pointer when Arlo sends
-- a resource, and says why. The copies arrive through the other door: a message sent from the
-- linked WhatsApp phone is filed as the team speaking and its media downloaded, and that path
-- has no way to know the workspace already holds the file.
--
-- ---------------------------------------------------------------- the key is the hash
--
-- `media/<workspace>/<sha256>`, so the same bytes land on the same object however many times
-- they arrive, and de-duplication needs no reference table to drift out of step. The hash is
-- kept on the row as well because it is what the next arrival is matched against, before
-- anything has been uploaded.
alter table attachments add column if not exists sha256      text;
alter table attachments add column if not exists storage_key text;

-- What the ingest path matches against, and what the sweep claims from. Partial, because the
-- rows worth finding are always the few that have not been dealt with yet.
create index if not exists attachments_sha on attachments (workspace_id, sha256) where sha256 is not null;
create index if not exists attachments_pending on attachments (id) where bytes is not null and storage_key is null;

-- ---------------------------------------------------------------- three states, two columns
--
--   bytes set, no key    just arrived; waiting to be compressed and moved
--   no bytes, key set    in Storage
--   neither              recorded, not kept -- past the window, or too big to have kept
--
-- The third already existed and the inbox already draws it: a file we do not hold shows its
-- name and size and says "not kept", because "they sent a 60MB video we did not keep" is a
-- fact somebody needs and a blank space reads as though they sent nothing.
