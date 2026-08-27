-- Telegram over long polling, for an install with no public address.
-- Why one transport or the other is in src/server/channels/telegram.ts.
--
-- `mode` is which transport a bot is on; 'webhook' by default, so bots added before this
-- file behave as they did.
--
-- `poll_offset` is the last update Telegram has been told we finished with, and the next
-- fetch asks for everything after it. In the table rather than in memory because the
-- alternative is replaying the last batch on every restart and answering somebody twice.
alter table telegram_bots
  add column if not exists mode text not null default 'webhook',
  add column if not exists poll_offset bigint;
