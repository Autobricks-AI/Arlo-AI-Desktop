-- What a call cost, as the provider reported it -- rather than as this app guessed.
--
-- `llm_usage` recorded tokens, and the page priced them from a rate typed into types.ts. That
-- rate is right for the one model everything defaults to and wrong for the rest of the
-- catalogue, and it cannot express the part that actually dominates an ordinary bill: the
-- provider charges whole credits with a per-request minimum, so a short call costs the
-- minimum however little it used. Pricing tokens was an estimate of the wrong quantity.
--
-- It was also not a record of anything. Cost was computed when the page rendered, so editing
-- the constant rewrote last month's figures along with this month's.
--
-- ---------------------------------------------------------------- why two columns
--
-- They answer different questions and neither implies the other. `cost_usd` is what the model
-- cost, passed through from upstream. `credits` is what was actually debited, which only the
-- provider can say because only it knows its own margin and rounding. Keeping both means the
-- gap between them is visible instead of being folded into a number nobody can take apart.
--
-- Per call, not per report: the minimum applies to each request, so a sum of stored rows is a
-- record of what happened and a sum of recomputed estimates is not.
--
-- Both nullable, no default, no backfill. Null means a row written before this existed, or one
-- whose provider does not report the figure. The page prices those from tokens the old way,
-- which is the only reason a blank is not the right answer for them.
alter table llm_usage
  add column if not exists cost_usd numeric,
  add column if not exists credits  integer;
