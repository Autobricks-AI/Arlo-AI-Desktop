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
     * Per bot, unlike everything above it.
     *
     * An answer is written for *this* bot, in the words its own customers should be given —
     * a support bot's phrasing is not a sales bot's. Empty in the wizard, where there is no
     * bot yet to have been taught anything.
     */
    examples: forBotId ? await lessons.examples(workspaceId, forBotId) : [],

    /*
     * Which files go out with which answer.
     *
     * One query for the whole set rather than one per row: the editor draws a checklist
     * against every answer at once, and asking per row is how a page with twenty of them
     * makes twenty round trips to render.
     */
    exampleResources: forBotId
      ? await lessons.resourcesFor(
          workspaceId,
          (await lessons.examples(workspaceId, forBotId)).map((e) => e.id),
        )
      : [],
  }
}
