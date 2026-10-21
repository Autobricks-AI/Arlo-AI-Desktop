-- Everything the training queue keeps on a lesson, which this schema never had room for.
--
-- ---------------------------------------------------------------- why one file and not ten
--
-- These columns were built up across nine earlier migrations -- the table itself, then files,
-- dates, prices, times, calendars, grouping and the suggested rewrites. None of those
-- filenames can be reused here.
--
-- 001_schema.sql is a squashed snapshot that already folded in *part* of what 027-047 built:
-- it creates `lessons` with fourteen columns and most of its indexes, but without the columns
-- that only the harvest-and-approve half uses. So 027 cannot be re-applied -- the table
-- exists -- and the later ones cannot be applied under their own names either, because
-- migrate() sorts by filename: `067_one_lesson_per_day.sql` would run *before* any new file
-- numbered above 081, and 067 indexes `coalesce(starts_on, ...)` on a column that would not
-- exist yet. It would fail on a fresh install, which is the one place it must not.
--
-- One file above the highest number already here is the only ordering that works.

-- ---------------------------------------------------------------- the columns
--
-- Every reference is `on delete set null`, which is the rule the whole table follows: a
-- lesson outlives what it produced. Delete the event an approved date created and the lesson
-- stays as the record that somebody approved it, rather than vanishing and being proposed
-- again from the same conversation next sweep.

alter table lessons
  -- What the knowledge base already said, when this was proposed. Shown beside a proposed
  -- fact so a reviewer can see it is not news. Text, not a reference: the passage it came
  -- from may be re-chunked or deleted, and the point is what it said at the time.
  add column if not exists nearest text,
  -- The document an approved fact was filed into. Also the idempotency latch: promote() bails
  -- when it is already set, so approving twice does not append the fact twice.
  add column if not exists document_id integer references documents (id) on delete set null;

alter table lessons
  -- A file the conversation carried, proposed for the library.
  add column if not exists attachment_id integer references attachments (id) on delete set null,
  -- And the resource it became once approved.
  add column if not exists resource_id integer references resources (id) on delete set null;

alter table lessons
  add column if not exists starts_on date,
  add column if not exists ends_on   date,
  add column if not exists repeats   text,
  add column if not exists event_id  integer references events (id) on delete set null;

alter table lessons
  add column if not exists price      numeric(14,2),
  add column if not exists currency   text,
  add column if not exists unit       text,
  add column if not exists product_id integer references products (id) on delete set null;

alter table lessons
  add column if not exists start_time time,
  add column if not exists end_time   time;

alter table lessons
  add column if not exists calendar_id integer references calendars (id) on delete set null;

alter table lessons
  -- Three states, and the difference matters: NULL means "not looked at yet" and is what the
  -- fold sweep selects on, `{}` means "looked, nothing like it", and a populated array is the
  -- partners. A default of `{}` would empty the work queue on the first boot after this runs.
  add column if not exists similar_ids integer[],
  -- Likewise three states: NULL is "never offered a rewording", '' is "offered and turned
  -- down", and text is a proposal waiting to be accepted.
  add column if not exists suggested text,
  -- The question half of that proposal. Two states only -- NULL or text -- because the empty
  -- string above already carries the dismissed marker for the pair.
  add column if not exists suggested_question text;

-- ---------------------------------------------------------------- the indexes

-- One proposal per file per bot, so a file that arrives in four conversations is offered once.
create unique index if not exists lessons_one_per_file
  on lessons (bot_id, attachment_id)
  where attachment_id is not null and status <> 'rejected';

-- The same answer on a different day is a different lesson.
--
-- 001_schema.sql carries this index keyed on (bot_id, kind, md5(lower(answer))), which is
-- correct until dates exist: a course meeting on three days proposes three rows whose answer
-- text is identical, and the three collapse to one through `on conflict do nothing`. Adding
-- the day to the key separates them.
--
-- `coalesce` is load-bearing rather than tidy. A nullable column in a unique index makes every
-- row distinct -- NULL is not equal to NULL -- so keying on `starts_on` raw would silently
-- switch the de-duplication off for every lesson that has no date, which is most of them.
drop index if exists lessons_one_per_answer;
create unique index if not exists lessons_one_per_answer
  on lessons (bot_id, kind, md5(lower(answer)), coalesce(starts_on, '0001-01-01'::date))
  where status <> 'rejected' and kind <> 'contact';

-- The fold sweep's work queue. Partial, so it holds only the rows still to be looked at and
-- empties itself as they are grouped. Contacts are excluded because they are never folded:
-- two people saying the same thing about themselves is not a duplicate.
create index if not exists lessons_ungrouped
  on lessons (id) where similar_ids is null and kind <> 'contact';

-- No RLS work: `lessons` and `lesson_resources` already carry tenant_read and tenant_write
-- from 001_schema.sql, and a policy is on the table rather than on its columns.
