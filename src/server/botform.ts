/**
 * Everything the chatbot form needs to render its choices.
 *
 * A module of its own rather than a function on bot.ts, and the reason is a cycle: the
 * channels import `agent.ts`, which imports `bot.ts`. If `bot.ts` reached back into the
 * channels to list connections, that circle would close. Only routes import this.
 */
import * as bots from './bot.ts'
import * as bases from './bases.ts'
import * as email from './channels/email.ts'
import * as telegram from './channels/telegram.ts'
import * as whatsapp from './channels/whatsapp.ts'
import * as web from './channels/web.ts'
import * as lessons from './lessons.ts'
import * as resources from './resources.ts'
import * as catalogue from './catalogue.ts'
import { available, catalogue as modelCatalogue } from './llm.ts'
import { availability } from './tools.ts'
import { TOOL_IDS } from '../types.ts'
import type { ChannelId } from '../types.ts'

export type Connection = { channel: ChannelId; ref: string; label: string; takenBy: string | null }

/**
 * Every connection in the workspace, and which bot already answers it.
 *
 * `takenBy` is the honest version of a disabled checkbox: the connection can still be
 * picked, and picking it moves it — which is what somebody reorganising two bots means.
 * Greying it out would make them go and un-tick a box on another page first.
 */
export async function options(workspaceId: number, forBotId?: number) {
  /*
   * Read once and used twice below -- for the list itself and for the ids its file checklist
   * is built from. It used to be fetched a second time just to pull the ids out, and the
   * grouping it does is not free, so the page paid for the whole thing twice and discarded one.
   */
  const deployed = forBotId ? await lessons.deployed(workspaceId, forBotId) : []

  const spoken = await bots.taken(workspaceId)
  const owner = (channel: string, ref: string) => {
    const found = spoken.find((s) => s.channel === channel && s.connection_ref === ref)
    return !found || found.bot_id === forBotId ? null : found.bot_name
  }

  const connections: Connection[] = [
    ...(await web.list(workspaceId)).map((w) => ({
      channel: 'web' as const,
      ref: w.id,
      label: w.label,
      takenBy: owner('web', w.id),
    })),
    ...(await telegram.list(workspaceId)).map((b) => ({
      channel: 'telegram' as const,
      ref: b.id,
      label: b.label,
      takenBy: owner('telegram', b.id),
    })),
    ...whatsapp.list(workspaceId).map((a) => ({
      channel: 'whatsapp' as const,
      ref: a.id,
      label: a.phone ? `${a.label} (+${a.phone})` : a.label,
      takenBy: owner('whatsapp', a.id),
    })),
    ...(await email.list(workspaceId)).map((m) => ({
      channel: 'email' as const,
      ref: m.id,
      label: m.address,
      takenBy: owner('email', m.id),
    })),
  ]

  return {
    connections,
    bases: await bases.list(workspaceId),
    model: await available(workspaceId),
    // Which models this workspace may pick, from whichever provider it is linked to. Read
    // here rather than hardcoded in the form, so linking an Autobricks key changes the list.
    models: await modelCatalogue(workspaceId),
    // Per tool, so the settings page can say "needs setup" and name what is missing
    // rather than offering a switch that quietly does nothing.
    toolsReady: Object.fromEntries(TOOL_IDS.map((id) => [id, availability(id)])),
    // Workspace-level, like knowledge sources: a file belongs to the company and any bot
    // may be given it, so the list is the same wherever it is picked from.
    resources: await resources.list(workspaceId),

    /*
     * What the company sells and the dates it keeps.
     *
     * Workspace-level like the resources above — a price list belongs to the business, not
     * to one bot — and edited here because this is the page anybody thinking about what a
     * bot knows is already on. Both are mirrored into the knowledge base on every write, so
     * the answering path never learns they exist.
     */
    products: await catalogue.products(workspaceId),
    events: await catalogue.events(workspaceId),
    calendars: await catalogue.calendars(workspaceId),

    /*
     * Counts for the tabs, and what the bot has already been taught. Not the queue itself.
     *
     * Per bot, unlike everything above it: a lesson is approved for *this* bot, in the words
     * its own customers should be given, and a support bot's phrasing is not a sales bot's.
     * Both are empty in the wizard, where there is no bot yet to have been taught anything.
     *
     * The queue is fetched a page at a time when the review door opens rather than coming
     * down with the loader -- on a bot with several hundred proposals it was almost the whole
     * payload, re-sent after every approval.
     */
    lessons: { counts: forBotId ? await lessons.queueCounts(workspaceId, forBotId) : {}, deployed },

    /**
     * Where this bot files what it learns.
     *
     * The page points at the base rather than reprinting what is in it: a hundred learned
     * facts is a knowledge base, and the place to read, edit or delete one is the knowledge
     * base — not a settings tab showing a copy that cannot be edited. Null until the first
     * fact is approved, because the base is made on demand.
     */
    learnedBase: forBotId ? await lessons.learnedBaseOf(workspaceId, forBotId) : null,

    /*
     * Which files go out with which approved example.
     *
     * One query for the whole set rather than one per example: the editor draws a checklist
     * against every example at once, and asking per row is how a page with twenty of them
     * makes twenty round trips to render.
     */
    lessonResources: await lessons.resourcesFor(
      workspaceId,
      deployed.filter((l) => l.kind === 'example').map((l) => l.id),
    ),
  }
}
