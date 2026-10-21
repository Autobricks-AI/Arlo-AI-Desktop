-- A picture of what is in the file, so the library is something you can look at.
--
-- ---------------------------------------------------------------- why a column, when the key is derivable
--
-- `media/<workspace>/<sha256>.thumb.webp` is the same content-addressed keyspace 069 and 071
-- established, and the row already carries both halves. So the column is not here to hold the
-- address. It is here to hold the fact that we looked.
--
-- Pulling the artwork out of a PDF is a regex over the whole file, an inflate and a re-encode.
-- Without somewhere to record "already tried", the sweep does all of that to every text-only
-- PDF in the workspace every sixty seconds, for ever, and finds the same nothing each time.
--
-- Three states in one text column, and the empty string is load-bearing:
--
--   NULL   not looked at yet -- this is the sweep's work queue
--   ''     looked, and there is nothing in it worth showing -- a contract, an invoice, anything
--          whose pages are text rather than artwork. The card falls back to its four-character
--          badge, which is what it shows today.
--   key    the preview, in Storage, beside the file it was cut from
--
-- A storage key is never the empty string, so the sentinel cannot collide with a real value.
alter table resources add column if not exists thumb_key text;

/*
 * The work queue, as an index.
 *
 * The predicate matches the sweep's WHERE exactly, which is the point: once every PDF has been
 * looked at this index is empty, and the sweep costs an index probe returning nothing rather
 * than a scan of the whole library every tick. The same partial-index shape 071 uses for
 * `resources_storage_key`, for the same reason.
 */
create index if not exists resources_preview_todo on resources (id)
  where thumb_key is null and mime = 'application/pdf';
