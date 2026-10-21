-- Making the long lists pageable, and their ordering stable enough to page.
--
-- ---------------------------------------------------------------- why now
--
-- `customers.list` returned every contact in the workspace and the browser filtered them.
-- That was written down as a deliberate deferral -- "fine into the low thousands... past that
-- it wants a LIMIT and the search moved into SQL" -- and it is past that: one workspace here
-- has 1,187 contacts, each row carrying a 31-column record including an AI-written summary
-- nothing on that page renders.
--
-- ---------------------------------------------------------------- the tiebreakers
--
-- These are a correctness fix, not a speed one, and they are the reason this migration exists
-- rather than the query just growing a LIMIT.
--
-- `customers_workspace` was (workspace_id, last_seen_at desc). `last_seen_at` is not unique --
-- an import backfills a phone's whole history in one go and hands hundreds of contacts the
-- same second. Postgres may return equal rows in any order, and it need not pick the same
-- order twice. Page one takes fifty of them, page two skips the first fifty *of a different
-- arrangement*, and rows silently repeat or vanish. Nobody reports that as a bug; they report
-- that a contact is missing.
--
-- So every ordering a page is taken from now ends in a unique column, and the index ends the
-- same way. Same fault, same fix, on `messages`, where a busy thread files several messages
-- inside one second and one conversation here holds five thousand of them.
--
-- ---------------------------------------------------------------- trigram, not tsvector
--
-- The knowledge base searches with tsvector, and that is the wrong instrument here.
--
-- What the contacts box does today is a substring match: `.includes(needle)` over name,
-- company, email, phone, city, country, owner, tags and traits. Somebody types `6580` to find
-- a phone, `@gmail` to find an address, a few letters to find a company. A tsvector matches word
-- stems and would answer none of those -- it would look like an upgrade and quietly delete
-- three of the ways people actually use the box.
--
-- pg_trgm indexes `ILIKE '%...%'` directly, so the SQL keeps doing what the browser did. It is
-- the first pg_trgm in this schema; that is worth knowing, but tsvector's presence next door
-- is not a precedent for identifiers.
--
-- The column is generated and stored rather than assembled in the query, because an
-- expression index over nine coalesced columns has to be repeated exactly at every call site
-- or it is silently not used.
--
-- The extension itself is created in setup/00-roles.sql, beside pgvector and for the reason
-- that file already gives: it needs rights the migration runner does not have. It is also not
-- safe to race, and the test suite runs a process per file. If this migration fails on
-- `gin_trgm_ops`, that setup step has not been run on this database.

/*
 * Everything the search box has always looked at, in one column.
 *
 * `traits` and `tags` go in as raw jsonb text. The browser spread `Object.values(c.traits)`
 * into the same haystack, so leaving them out would narrow the box rather than move it -- but
 * a generated column may not contain a subquery, which rules out unnesting them properly with
 * jsonb_each_text. The cast is the honest trade: a trait *key* becomes searchable alongside
 * its value, and searching `tier` finds everyone who has one. Harmless for a contact list, and
 * the alternative is a trigger, which is a second place for this to drift out of step.
 *
 * Deliberately NOT included: `notes` and `summary`. Both are long, both are written by us
 * rather than about them, and both would bloat the trigram index with prose that nobody
 * searches a contact list by. If somebody asks for it later it is one line -- but it is a
 * decision, not an oversight.
 */
alter table customers add column if not exists search text
  generated always as (
    lower(
      coalesce(name, '') || ' ' ||
      coalesce(first_name, '') || ' ' ||
      coalesce(last_name, '') || ' ' ||
      coalesce(company, '') || ' ' ||
      coalesce(job_title, '') || ' ' ||
      coalesce(email, '') || ' ' ||
      coalesce(phone, '') || ' ' ||
      coalesce(city, '') || ' ' ||
      coalesce(country, '') || ' ' ||
      coalesce(owner, '') || ' ' ||
      coalesce(tags::text, '') || ' ' ||
      coalesce(traits::text, '')
    )
  ) stored;

create index if not exists customers_search on customers using gin (search gin_trgm_ops);

/*
 * The ordering the contacts page is paged from, ending in a unique column.
 *
 * The old index is dropped rather than left beside this one: its leading columns are a prefix
 * of these, so it can answer nothing this cannot, and a second index on a hot table is a write
 * cost paid on every message that touches a contact.
 */
drop index if exists customers_workspace;
create index if not exists customers_workspace on customers (workspace_id, last_seen_at desc, id desc);

-- The same fix for a thread's transcript. `messages_thread` was (conversation_id, created_at)
-- with no tiebreaker, and no workspace_id -- which Postgres tolerates because conversation_id
-- is the selective column, but the sort within one second was still real.
drop index if exists messages_thread;
create index if not exists messages_thread on messages (conversation_id, created_at, id);

/*
 * The inbox filters on status and nothing indexed it.
 *
 * Both the chip filter and the counts beside it were full scans of the workspace's
 * conversations. That was survivable while the list was capped at 200 and filtered in the
 * browser; it stops being survivable when the filter moves into SQL, which is what makes the
 * chips and the rows agree.
 */
create index if not exists conversations_status on conversations (workspace_id, status, last_at desc, id desc);
