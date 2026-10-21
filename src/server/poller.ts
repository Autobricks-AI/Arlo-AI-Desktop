/**
 * The timer.
 *
 * Mail needs one, having no webhook worth having, and so does a crawl or an upload whose
 * hand-off never landed. Both are sweeps over a table, so both live on one interval.
 *
 * ponytail: one `setInterval`, everything in sequence, no queue and no external scheduler.
 * The ceiling is honest and worth writing down: **nothing runs while the process is
 * stopped.** A reminder due during a deploy fires late, on the next tick, rather than not
 * at all — but a scheduled task that must fire during an outage needs something outside
 * this process, and that is the upgrade path.
 */
import { sweepAll } from './channels/email.ts'
import { purgeExpiredSessions } from './auth.ts'
import { sweep as sweepCrawls } from './sites.ts'
import { sweep as sweepUploads } from './uploads.ts'
import { sweepEmbeddings } from './embed.ts'
import { sweep as sweepLessons, sweepGroups } from './lessons.ts'
import { sweepMedia } from './media.ts'
import { sweepThumbs } from './resources.ts'

/*
 * Guarded, because `Number()` answers NaN for anything that is not a number and
 * `setInterval(fn, NaN)` is `setInterval(fn, 0)` — a tick every millisecond, each one running
 * a model call per row. A typo in the environment should slow nothing down and stop nothing;
 * it falls back to the default, and a zero or a negative still means "no poller" as before.
 */
const CONFIGURED = Number(process.env.POLL_SECONDS ?? 60)
const SECONDS = Number.isFinite(CONFIGURED) ? CONFIGURED : 60

/**
 * On globalThis so a dev hot-reload cannot start a second timer — two of these would
 * double every sweep and race each other for the same rows.
 */
const state: { timer: NodeJS.Timeout | null; running: boolean; gen: number } = ((globalThis as any).__arloPoller ??= {
  timer: null,
  running: false,
  gen: 0,
})

/**
 * Which copy of this module owns the timer.
 *
 * Surviving a reload is the point of `state`, and also its trap: the callback closes over
 * the previous copy of this file and keeps sweeping with it, against a database the
 * migrations have since moved on. The same thing cost a WhatsApp message earlier — see
 * channels/whatsapp.ts — and here it would be quieter still, because a timer nobody is
 * watching fails in the background.
 */
const GEN: number = ((globalThis as any).__arloPollerGen = (((globalThis as any).__arloPollerGen as number) ?? 0) + 1)

async function tick() {
  // A slow sweep is skipped, not stacked. Otherwise a mailbox that takes ninety seconds
  // on a sixty-second timer accumulates overlapping sweeps until something falls over.
  if (state.running) return
  state.running = true
  try {
    // Does not throw: it records its own failures per mailbox, so one bad mailbox does not
    // stop the others.
    await sweepAll()
    // Backstop only: both normally start the instant they are submitted.
    await sweepCrawls()
    await sweepUploads()
    // Whatever was stored while there was no embeddings key. Cheap, and it stops a
    // half-embedded corpus retrieving worse than an unembedded one.
    await sweepEmbeddings()
    /*
     * Files out of the database and into the store, a few per tick, and previews made for
     * the ones that can have them. Both no-op with nowhere to put bytes, so an install that
     * has not configured a store keeps its files in Postgres exactly as before.
     *
     * A few per tick rather than all of them because this is the only sweep that moves
     * megabytes: a workspace catching up on a year of attachments should do it over an
     * afternoon, not hold the interval open while it reads the whole table into memory.
     */
    await sweepMedia()
    await sweepThumbs()
    // Expiry is enforced on read, so this is only housekeeping — it stops the table growing
    // by one row for every sign-in nobody ever signed out of.
    await purgeExpiredSessions()
    /*
     * Reads finished conversations for what the team answered and what the customer said
     * about themselves. Near the end, because it is the only sweep here that can spend a
     * model call per row -- and after sweepEmbeddings() above, so a lesson stored while there
     * was no key has a vector before anything tries to match it.
     */
    await sweepLessons()

    /*
     * Straight after the harvest, which is what makes the queue look right rather than nearly
     * right: the sweep above is what creates the proposals, so working out what they repeat
     * in the same tick means a new near-duplicate arrives already folded under the row that
     * said it first.
     *
     * Cheap and offline -- it compares text with pg_trgm's similarity() rather than
     * embeddings, so it needs no key and costs no network. The expensive half of this fold
     * used to run on the chatbot page instead, twice per load.
     */
    await sweepGroups()
  } catch (e) {
    console.error('[poller] sweep failed:', e instanceof Error ? e.message : e)
  } finally {
    state.running = false
  }
}

/**
 * Start sweeping. Called once at boot by whichever process owns the singletons.
 *
 * POLL_SECONDS=0 disables it entirely, which is what the tests and any process that is
 * not meant to sweep use.
 */
export function startPolling() {
  if (SECONDS <= 0) return
  // A timer an older copy of this module started is running that copy's code. Replace it.
  if (state.timer && state.gen !== GEN) stopPolling()
  if (state.timer) return
  state.gen = GEN
  // Once immediately, so a restart catches up on whatever arrived while it was down.
  void tick()
  state.timer = setInterval(tick, SECONDS * 1000)
  // Housekeeping must not be what keeps the process alive.
  state.timer.unref?.()
}

export function stopPolling() {
  if (state.timer) clearInterval(state.timer)
  state.timer = null
}
