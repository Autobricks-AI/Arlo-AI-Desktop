/**
 * What a chatbot can do besides talk.
 *
 * A tool is something the model decides to use on its own, mid-answer. That is the whole
 * reason each one is granted per bot rather than switched on globally: the model chooses,
 * so the choice of what it may choose from belongs to whoever configured the bot.
 *
 * Every tool here answers to the same three rules:
 *
 *   bounded    it takes arguments the model wrote, so every one is validated and capped.
 *   honest     a tool that cannot run says so, and says why, rather than returning nothing
 *              and letting the model conclude the answer is "no".
 *   attributed a result that did not come from the company's own material is labelled as
 *              such, so an answer built on it is not passed off as company policy.
 */
import * as z from 'zod'
import { setStatus } from './conversations.ts'
import { retrieve } from './retrieve.ts'
import type { Scope } from './retrieve.ts'
import { boundedFetch } from './net.ts'
import * as resources from './resources.ts'
import type { Sendable } from './resources.ts'
import { TOOLS } from '../types.ts'
import type { ToolId } from '../types.ts'

/**
 * The address a customer will actually open.
 *
 * Read from PUBLIC_URL, never built from the request: a resource link is sent to somebody
 * on WhatsApp, and behind a proxy the host this process sees is a loopback port they could
 * never reach.
 */
const publicBase = () => (process.env.PUBLIC_URL || 'http://127.0.0.1:9005').replace(/\/+$/, '')

/** What a tool needs to know about the conversation it is being used in. */
export type Context = {
  workspaceId: number
  /** Whose permissions apply. A bot may only send what it has been given. */
  botId: number
  conversationId: number
  scope: Scope
  /** Set when a tool asks for a person. The agent reads it after the loop. */
  flagged?: { reason: string }
  /**
   * Files a tool chose to send. Attached by deliver() after the loop, not here.
   *
   * The same shape as `flagged` and for the same reason: a tool runs mid-loop, long before
   * there is a message to hang anything on, so the context is how it says what it wants.
   */
  sending?: Sendable[]
}

type Tool = {
  /** The parameters the model must supply, and the shape they are checked against. */
  schema: z.ZodType<any>
  /** How the model is told to use it. Shorter than the blurb: this is not marketing copy. */
  instruction: string
  /** Null when usable. A string when not — shown to the model as the result. */
  unavailable: () => string | null
  run: (args: any, ctx: Context) => Promise<string>
}

const REGISTRY: Record<ToolId, Tool> = {
  // ---------------------------------------------------------------- knowledge
  search_knowledge: {
    schema: z.object({
      query: z.string().describe('What to look for, in the words the documents would use'),
    }),
    instruction:
      'Search the company knowledge base again with different wording. Use when the reference passages ' +
      'do not answer the question but you think the material exists under other words.',
    unavailable: () => null,
    run: async ({ query }, ctx) => {
      const hits = await retrieve(ctx.workspaceId, String(query).slice(0, 500), { k: 5, scope: ctx.scope })
      if (!hits.length) return 'No passages matched that either. The knowledge base does not cover it.'
      return hits.map((h, i) => `PASSAGE ${i + 1} — ${h.title}\n${h.text}`).join('\n\n')
    },
  },

  // ---------------------------------------------------------------- the open web
  web_search: {
    schema: z.object({ query: z.string().describe('What to search the public web for') }),
    instruction:
      'Search the public web. The results are NOT company material: never present anything from them as ' +
      'this company policy, price or commitment, and say where it came from.',
    unavailable: () =>
      process.env.BRAVE_SEARCH_KEY ? null : 'Web search is not configured on this server. Answer without it.',
    run: async ({ query }) => {
      const url = `https://api.search.brave.com/res/v1/web/search?count=5&q=${encodeURIComponent(String(query).slice(0, 400))}`
      const res = await fetch(url, {
        headers: { accept: 'application/json', 'x-subscription-token': process.env.BRAVE_SEARCH_KEY! },
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) return `The web search failed (${res.status}). Answer without it.`

      const json = (await res.json()) as { web?: { results?: { title: string; url: string; description: string }[] } }
      const results = json.web?.results ?? []
      if (!results.length) return 'Nothing came back from the web for that.'

      // Labelled on every line, not once at the top: the model quotes lines, not headers.
      return results
        .slice(0, 5)
        .map((r) => `[from the public web] ${r.title} — ${r.description}\n${r.url}`)
        .join('\n\n')
    },
  },

  // ---------------------------------------------------------------- sending things
  send_resource: {
    schema: z.object({
      name: z.string().describe('The title of the resource to send, as listed'),
    }),
    instruction:
      'Attach a file or link from the list you have been given to your reply. Use the exact title. ' +
      'It is attached for you — write the sentence that goes with it and do not paste an address.',
    unavailable: () => null,
    run: async ({ name }, ctx) => {
      const permitted = await resources.forBot(ctx.workspaceId, ctx.botId)
      if (!permitted.length) return 'There are no resources available to send on this conversation.'

      const wanted = String(name).trim().toLowerCase()
      /*
       * Exact title first, then a contains match. The model was given the list, so an exact
       * hit is the normal case; the loose pass is for when it paraphrases slightly. It
       * never invents an address — a miss returns the list, so the next attempt is right.
       */
      const found =
        permitted.find((r) => r.title.toLowerCase() === wanted) ??
        permitted.find((r) => r.title.toLowerCase().includes(wanted) || wanted.includes(r.title.toLowerCase()))

      if (!found)
        return `No resource called "${name}". You may send: ${permitted.map((r) => r.title).join(', ')}.`

      /*
       * Queued, not sent. deliver() reads this off the context after the loop and hands it to
       * the channel, which uploads the bytes — so "attached" is now true on WhatsApp,
       * Telegram and mail, and a link only where the file genuinely cannot go.
       */
      ;(ctx.sending ??= []).push(found)
      return `${found.title} is attached to your reply. Write the sentence that goes with it — do not paste an address.`
    },
  },

  // ---------------------------------------------------------------- people
  notify_team: {
    schema: z.object({
      reason: z.string().describe('What a person needs to know, in one sentence'),
    }),
    instruction:
      'Flag this conversation for a person, with a reason, and carry on answering. Use when somebody on ' +
      'the team must see this even though you can answer the question. Do not use it to hand off — set ' +
      'handoff for that.',
    unavailable: () => null,
    run: async ({ reason }, ctx) => {
      const why = String(reason).trim().slice(0, 300)
      /*
       * The flag is recorded on the context and applied by the agent after the loop, not
       * here. A tool that set the thread to `human` mid-answer would stop the very reply
       * it is explaining — and the model called this precisely because it intends to keep
       * talking.
       */
      ctx.flagged = { reason: why }
      return `Flagged for the team: ${why}. Tell the customer a person will look at it; do not promise when.`
    },
  },
}

/** Only ids the registry knows. A stored id that no longer exists is silently ignored. */
export const known = (ids: unknown): ToolId[] =>
  Array.isArray(ids) ? ids.filter((id): id is ToolId => typeof id === 'string' && id in REGISTRY) : []

/** Whether the server can actually run this tool right now. */
export const availability = (id: ToolId) => REGISTRY[id].unavailable()

/**
 * The tool definitions to send with a model call, in OpenAI's shape.
 *
 * A tool the server cannot run is still offered, and still returns its explanation when
 * called. Hiding it would leave the model with no way to say "I could not look that up" —
 * it would simply answer as though the question had no answer.
 */
export function definitions(ids: ToolId[], sendable: string[] = []) {
  return ids.map((id) => {
    const json = z.toJSONSchema(REGISTRY[id].schema, { io: 'output' }) as Record<string, unknown>
    delete json.$schema
    return {
      type: 'function' as const,
      function: { name: id, description: `${TOOLS[id].name}. ${REGISTRY[id].instruction}${named(id, sendable)}`, parameters: json },
    }
  })
}

/**
 * The list send_resource has always claimed the model was given.
 *
 * It was not. The instruction read "from the list you have been given" and no list was
 * anywhere -- not in the system prompt, not in the tool, nowhere. A model that cannot name a
 * file will not call a tool that wants its exact title, so it did the next best thing and
 * wrote the filename into the sentence instead: "Here is the brochure: Spring_Brochure_v7.pdf",
 * with no file attached and nothing for the customer to open.
 *
 * On the tool rather than in the prompt because the tool is where the model is deciding, and
 * because a bot without send_resource granted should not pay for the titles on every turn.
 */
const named = (id: ToolId, sendable: string[]) =>
  id !== 'send_resource'
    ? ''
    : sendable.length
      ? ` The ones available on this conversation, by exact title: ${sendable.join('; ')}.`
      : ' There are none available on this conversation, so do not offer a file or name one.'

/**
 * Run one call the model asked for.
 *
 * Never throws. Every outcome — bad arguments, an unknown tool, a provider that is down —
 * comes back as text the model can read and work around, because the alternative is losing
 * the whole answer to a tool that was only ever optional.
 */
export async function invoke(id: string, rawArgs: string, ctx: Context): Promise<string> {
  const tool = REGISTRY[id as ToolId]
  if (!tool) return `There is no tool called ${id}.`

  const unavailable = tool.unavailable()
  if (unavailable) return unavailable

  let args: unknown
  try {
    args = JSON.parse(rawArgs || '{}')
  } catch {
    return 'Those arguments were not valid JSON. Try again or answer without this tool.'
  }

  const parsed = tool.schema.safeParse(args)
  if (!parsed.success) return `Those arguments were wrong: ${parsed.error.message.slice(0, 200)}`

  try {
    return await tool.run(parsed.data, ctx)
  } catch (e) {
    console.error(`[tools] ${id} failed:`, e instanceof Error ? e.message : e)
    return `That tool failed. Answer without it.`
  }
}
