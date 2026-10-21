-- The other half of 069: the files we *send* leave the database too.
--
-- ---------------------------------------------------------------- why this is not already done
--
-- 069 moved `attachments` to the file store because they were most of the database. It left
-- `resources` alone, and at the time that was right: a handful of them, a brochure and a price
-- list, and moving a table nobody was filling would have been work for its own sake.
--
-- Two things changed. A database that fills up goes read-only, which is the failure mode an
-- unbounded `bytea` column produces and the reason to stop producing it. And `resources` is
-- about to become the destination for a workspace-wide media library -- the only store with a
-- sendable public address, so anything somebody shares has to land here. "Share freely from a
-- central repo" is the instruction most likely to refill the thing 069 emptied.
--
-- ---------------------------------------------------------------- what stays exactly as it was
--
-- **The bucket is private and the public face does not move.** A resource is reachable by anyone
-- holding its token, through `/api/resource/<token>`, because that address ends up inside a
-- WhatsApp message somebody forwards to a colleague. That route keeps serving the bytes; it just
-- fetches them from Storage instead of from a column. No signed URLs: the route's ETag and 304
-- are what make a provider's repeated fetch of the same file cheap, and a signed URL would expire
-- inside a message that outlives it.
--
-- **No backfill.** `byToken()` reads a row with bytes and a row with a key, so the handful of
-- existing rows stay as they are and nothing has to be migrated at a moment when the database is
-- the thing under pressure. They age out naturally as files are replaced.

alter table resources add column if not exists storage_key text;

/*
 * The content hash, and the reason this column is worth having rather than deriving.
 *
 * `media/<workspace>/<sha256>` is the same keyspace `attachments` uses, so a file that arrived in
 * a conversation and the same file sent from the library are one object, stored once. That is
 * what makes "make this attachment shareable" a pointer rather than a second copy -- and the
 * sweep in media.ts can then see that a resource is holding the object and leave it alone.
 */
alter table resources add column if not exists sha256 text;

/*
 * Where this file came from, for a human reading the library.
 *
 * Null on everything that already exists, and on anything older than this column. No CHECK
 * constraint: 'upload' | 'lesson' | 'chat' are today's answers and there will be a fourth.
 *
 * It earns its place for exactly one of those. A file somebody uploaded in the chatbot editor is
 * unremarkable, and `lessons.resource_id` already records which lesson approved one -- but a file
 * lifted out of a customer's conversation and given a public address is the one case where
 * somebody may later need to ask "why is this shareable", and the answer has to be on the row.
 */
alter table resources add column if not exists source text;

create index if not exists resources_sha on resources (workspace_id, sha256) where sha256 is not null;

/*
 * How the sweep finds a resource holding an object.
 *
 * `forgetOldMedia()` deletes a Storage object once no attachment inside the retention window
 * refers to it. A resource pointing at that key would lose its bytes on day 30 and start
 * answering 404 on a link already sent to customers, so the sweep now checks here too -- and
 * this index is what keeps that check from being a scan per candidate key.
 */
create index if not exists resources_storage_key on resources (storage_key) where storage_key is not null;
