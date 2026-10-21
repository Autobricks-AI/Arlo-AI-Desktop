-- Blue for a calendar, so it is not the same green as everything else the app draws.
--
-- The palette gained a red at the same time (see CALENDAR_COLOURS): a project's dates are now
-- drawn in it, and there was no red at all before — clay is a terracotta and reads orange
-- beside amber. Blue and red are the two a person expects to tell apart at a glance in a grid
-- holding both.
--
-- ---------------------------------------------------------------- only the untouched ones
--
-- `colour = 'moss'` is the old default, and `is_default` is the calendar every workspace was
-- given rather than one somebody made. Together they mean "nobody has ever chosen a colour for
-- this", which is the only thing safe to change underneath somebody. A calendar that was made
-- by hand, or one whose colour was picked, keeps what it has — including a hand-made calendar
-- that happens to be moss, because that was a choice.
update calendars set colour = 'sky' where is_default and colour = 'moss';

-- New workspaces start there too, rather than inheriting the old default from the column.
alter table calendars alter column colour set default 'sky';
