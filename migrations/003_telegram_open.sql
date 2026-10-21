-- A bot that answers anyone who finds it.
--
-- The allow list stays the default, and for a good reason: a bot's handle is public, so open
-- by default would hand the first stranger to find it the workspace's model budget and
-- whatever the knowledge base knows.
--
-- But a support bot is meant to be found, and its owner cannot name every customer in
-- advance. So this is a switch rather than a change of mind — false here, so every bot
-- connected before this file keeps the behaviour it already had.
alter table telegram_bots
  add column if not exists open boolean not null default false;
