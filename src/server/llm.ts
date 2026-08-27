/**
 * The model call.
 *
 * Plain `fetch` over an OpenAI-shaped chat-completions endpoint — no SDK, no framework.
 *
 * ---------------------------------------------------------------- one provider
 *
 * Autobricks, and nothing else. Arlo Desktop is self-hosted, so there is no shared key to
 * bill centrally and no reason for this file to know two naming schemes: the operator brings
 * their own Autobricks key, it is saved per workspace, and every call in the app goes out on
 * it. Adding another provider is a deliberate fork — change `ENDPOINT` and `modelFor` here,
 * which is the whole of it.
 *
 * The key is read per call from `workspaces` rather than the environment, because Settings
 * can change it while the process is running and a cached one would keep spending against
 * an account somebody has just moved off.
 *
 * With no key saved, every call returns null. Nothing here throws to signal "no model",
 * because having no model is a supported state: the agent declines to answer rather than
 * inventing one. A key that *is* set and fails does throw — that is a real problem with a
 * real key, and swallowing it would silently degrade every answer with nobody noticing.
 *
 * **Embeddings do not come through here.** `embed.ts` has its own endpoint and key, because
 * Autobricks serves no `/v1/embeddings` yet. That is the one call this file's promise does
 * not cover, and it is written down in embed.ts too.
 */
import type { ZodType } from 'zod'
import * as z from 'zod'
import { all, asSystem, one, run } from './db.ts'
import { openOrNull } from './secrets.ts'

const ENDPOINT = 'https://api.autobricksai.com/v1/chat/completions'

type Resolved = { endpoint: string; key: string; provider: string }

/**
 * The key this workspace answers on, or null if none is saved.
 *
 * Reads `workspaces` directly rather than through the request's own tenant scope: a model
 * call can happen with no scope open at all — a slow call is deliberately made outside
 * `withWorkspace()` so it never holds a pooled connection open — so this has to work the
 * same regardless of what scope, if any, is active.
 */
async function resolveProvider(workspaceId: number): Promise<Resolved | null> {
  const ws = await asSystem(() =>
    one<{ autobricks_key_enc: string | null }>(`SELECT autobricks_key_enc FROM workspaces WHERE id = ?`, workspaceId),
  )
  const key = openOrNull(ws?.autobricks_key_enc ?? null) || process.env.AUTOBRICKS_API_KEY || ''
  return key ? { endpoint: ENDPOINT, key, provider: 'autobricks' } : null
}

/**
 * Which model to ask for.
 *
 * A bot may name one, and it is used as given — the catalogue it was picked from is this
 * provider's own, so there is no longer a way to choose a model the endpoint has never heard
 * of. Anything blank falls back to gpt-4.1-mini on the budget tier, so a brand-new account
 * that has bought no credit still answers.
 */
const modelFor = (wanted?: string | null) =>
  wanted?.trim() || process.env.AUTOBRICKS_MODEL || 'autobricksai/gpt-4.1-mini'

export type ModelChoice = { id: string; label: string; tier: string | null }
export type Catalogue = {
  /** 'autobricks', or 'none' when no key is saved. */
  provider: string
  /** What a bot that chooses nothing actually runs on. */
  fallback: string
  models: ModelChoice[]
  /** True when the list came from the provider, false when it is the built-in shortlist. */
  live: boolean
}

/**
 * What to offer before the provider's own list has been read.
 *
 * Only a fallback: the live catalogue below is small enough to show whole, and is what
 * somebody actually picks from. This exists so the chatbot page still offers something when
 * the API is unreachable.
 */
const SHORTLIST = ['autobricksai/gpt-4.1-mini', 'autobricksai/gpt-4.1', 'autobricksai/gpt-4o-mini']

/*
 * Read once every few minutes, not once per form render.
 * 
 * The chatbot page rebuilds its options on every save and every tab, and none of them are
 * worth a round trip to another company's API.
 *
 * Stamped with the credential it was read for, not just the workspace. Pasting a new key is
 * the one moment somebody is definitely looking at this list, and a cache that ignored the
 * change would show them the old account's models for five minutes — which is the exact
 * thing they just changed the key to fix.
 */
const CACHE = new Map<number, { at: number; for: string; v: Catalogue }>()
const CACHE_MS = 5 * 60_000

/**
 * Which models this workspace may actually pick, and what it falls back to.
 *
 * Read from the account rather than hard-coded, so what the chatbot page offers is what this
 * key can actually reach — a list that names a model the account cannot use is not merely
 * cosmetic, it is a bot that 400s on every call.
 */
export async function catalogue(workspaceId: number): Promise<Catalogue> {
  const provider = await resolveProvider(workspaceId)
  if (!provider) return { provider: 'none', fallback: modelFor(), models: [], live: false }

  const shortlist = (live: boolean): Catalogue => ({
    provider: provider.provider,
    fallback: modelFor(),
    models: SHORTLIST.map((id) => ({ id, label: id, tier: null })),
    live,
  })

  const stamp = provider.provider + ':' + provider.key
  const hit = CACHE.get(workspaceId)
  if (hit && hit.for === stamp && Date.now() - hit.at < CACHE_MS) return hit.v

  try {
    const res = await fetch(provider.endpoint.replace('/chat/completions', '/models'), {
      headers: { Authorization: 'Bearer ' + provider.key },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(await reason(res))
    const json = (await res.json()) as { data?: { id?: string; display_name?: string; tier?: string }[] }
    const models = (json.data ?? [])
      .filter((m): m is { id: string; display_name?: string; tier?: string } => !!m.id)
      .map((m) => ({ id: m.id, label: m.display_name || m.id, tier: m.tier ?? null }))
    // An empty list is a broken answer, not an account with no models. Keep the shortlist,
    // or the page offers nothing to pick and every bot looks unconfigurable.
    if (!models.length) return shortlist(false)

    const v: Catalogue = { provider: provider.provider, fallback: modelFor(), models, live: true }
    CACHE.set(workspaceId, { at: Date.now(), for: stamp, v })
    return v
  } catch (e) {
    // Their API being down must not make the chatbot page unopenable.
    console.error('[llm] could not read the model list:', e instanceof Error ? e.message : e)
    return shortlist(false)
  }
}
/** Is a model configured for this workspace right now — its own key, or the shared one. */
export const available = async (workspaceId: number) => !!(await resolveProvider(workspaceId))

/**
 * What a call was for, so the bill can be read rather than guessed at.
 *
 * Free text rather than a union, on purpose: a new caller should be able to log without
 * touching this file, and an unfamiliar value is still better than the null it replaces.
 * The ones in use are `answer`, `tool_round`, `harvest`, `qualify`, `identity`, `graph`,
 * `catalogue`, `summary`.
 *
 * `conversationId` is what makes an answer addable up. Answering one message is several
 * calls — the tool rounds and then the answer — so the useful unit of cost is a thread.
 */
export type Spend = { purpose: string; conversationId?: number | null }

/**
 * One row per call. Never lets a logging failure fail the answer it is logging — the call
 * already succeeded by the time this runs, and losing a usage row is a worse trade than
 * losing an answer over it.
 */
async function recordUsage(
  workspaceId: number,
  provider: string,
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number },
  about?: Spend,
  model?: string,
) {
  if (!usage) return
  await asSystem(() =>
    run(
      `INSERT INTO llm_usage (workspace_id, provider, prompt_tokens, completion_tokens, total_tokens, purpose, conversation_id, model)
       VALUES (?,?,?,?,?,?,?,?)`,
      workspaceId,
      provider,
      usage.prompt_tokens ?? 0,
      usage.completion_tokens ?? 0,
      usage.total_tokens ?? 0,
      about?.purpose ?? null,
      about?.conversationId ?? null,
      model ?? null,
    ),
  ).catch((e) => console.error('[llm] could not record usage:', e instanceof Error ? e.message : e))
}

export type ToolCall = { id: string; name: string; arguments: string }

export type Message = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Set on an assistant turn that asked for tools; echoed back so the model sees its own. */
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  /** Set on a tool turn: which call this is the result of. */
  tool_call_id?: string
}

/**
 * OpenAI's strict JSON-schema mode is stricter than "valid JSON Schema": every object
 * must forbid extra properties and must list every one of its properties as required.
 * Zod emits neither for a schema with optional fields, so they are forced here.
 *
 * A field the model genuinely may omit is therefore modelled as nullable rather than
 * optional — `.nullable()` in the schema, not `.optional()`.
 */
function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify)
  if (!node || typeof node !== 'object') return node

  const out = node as Record<string, unknown>
  for (const [k, v] of Object.entries(out)) if (k !== 'required') out[k] = strictify(v)

  if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
    out.additionalProperties = false
    out.required = Object.keys(out.properties as Record<string, unknown>)
  }
  return out
}

type Json = {
  choices?: {
    message?: {
      content?: string | null
      tool_calls?: { id: string; function?: { name?: string; arguments?: string } }[]
    }
  }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

/**
 * The one place that actually calls out. `chat`/`structured`/`withTools` all funnel through
 * here, so provider resolution and usage logging only ever happen in one place.
 */
async function request(
  workspaceId: number,
  body: Record<string, unknown>,
  timeoutMs: number,
  model: string | null | undefined,
  about: Spend,
): Promise<Json | null> {
  const provider = await resolveProvider(workspaceId)
  if (!provider) return null

  // Hoisted so the same value is both sent and recorded. Resolved, not requested: a bot that
  // names nothing runs on the fallback, and the usage tables should say which model actually
  // answered rather than which one was asked for.
  const ran = modelFor(model)

  const res = await fetch(provider.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${provider.key}`,
      'content-type': 'application/json',
      // Optional attribution headers OpenRouter uses for its dashboard; harmless elsewhere.
      ...(process.env.PUBLIC_URL ? { 'http-referer': process.env.PUBLIC_URL } : {}),
      'x-title': 'Arlo AI',
    },
    // The workspace's own choice wins where the provider can honour it; see modelFor.
    body: JSON.stringify({ model: ran, ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`Model provider said ${res.status}: ${await reason(res)}`)

  const json = (await res.json()) as Json
  await recordUsage(workspaceId, provider.provider, json.usage, about, ran)
  return json
}

/**
 * What went wrong, in words rather than as a wall of JSON.
 *
 * Two shapes to read, because they come from different layers: the completion path answers
 * with the OpenAI envelope `{error:{message}}`, while a rejected key answers from the auth
 * dependency in front of it as `{detail:"invalid_api_key"}`. Falling back to the raw body
 * covers anything else, truncated so a stack trace does not become the message.
 */
async function reason(res: Response): Promise<string> {
  const body = (await res.text()).slice(0, 600)
  try {
    const j = JSON.parse(body) as { error?: { message?: string }; detail?: string }
    return j.error?.message ?? j.detail ?? body
  } catch {
    return body
  }
}

async function call(
  workspaceId: number,
  body: Record<string, unknown>,
  timeoutMs: number,
  model: string | null | undefined,
  about: Spend,
): Promise<string | null> {
  const json = await request(workspaceId, body, timeoutMs, model, about)
  return json?.choices?.[0]?.message?.content ?? null
}

/** Free-text completion. Null when no model is configured for this workspace. */
export const chat = (
  workspaceId: number,
  messages: Message[],
  { maxTokens = 1024, timeoutMs = 60_000, model = null as string | null, purpose = 'chat', conversationId = null as number | null } = {},
) => call(workspaceId, { messages, max_tokens: maxTokens }, timeoutMs, model, { purpose, conversationId })

/**
 * One turn that may ask for tools.
 *
 * Returns either the calls the model wants made, or the text it produced instead. Kept as
 * a single turn rather than a loop with the running inside it: what a tool does, and how
 * many times it may be asked for, is the caller's decision, not this file's.
 */
export async function withTools(
  workspaceId: number,
  messages: Message[],
  tools: unknown[],
  { maxTokens = 1024, timeoutMs = 60_000, model = null as string | null, purpose = 'tool_round', conversationId = null as number | null } = {},
): Promise<{ calls: ToolCall[]; content: string | null } | null> {
  const json = await request(workspaceId, { messages, tools, max_tokens: maxTokens }, timeoutMs, model, { purpose, conversationId })
  if (!json) return null

  const message = json.choices?.[0]?.message
  return {
    calls: (message?.tool_calls ?? []).map((c) => ({
      id: c.id,
      name: c.function?.name ?? '',
      arguments: c.function?.arguments ?? '{}',
    })),
    content: message?.content ?? null,
  }
}

/**
 * A completion the model is required to shape like `schema`.
 *
 * The schema is enforced twice on purpose: `strict: true` makes the provider generate
 * conforming JSON, and parsing it back through Zod is what makes that a *guarantee* here
 * rather than a promise made in another company's service. A provider that ignores the
 * schema, or a model that returns prose, fails at the parse and returns null rather than
 * handing a half-shaped object to a caller that will index into it.
 */
export async function structured<T>(
  workspaceId: number,
  schema: ZodType<T>,
  messages: Message[],
  { name = 'result', maxTokens = 2048, timeoutMs = 90_000, model = null as string | null, purpose = '', conversationId = null as number | null } = {},
): Promise<T | null> {
  const json = z.toJSONSchema(schema, { io: 'output' }) as Record<string, unknown>
  delete json.$schema

  const content = await call(
    workspaceId,
    {
      messages,
      max_tokens: maxTokens,
      response_format: { type: 'json_schema', json_schema: { name, strict: true, schema: strictify(json) } },
    },
    timeoutMs,
    model,
    { purpose: purpose || name, conversationId },
  )
  if (!content) return null

  const parsed = schema.safeParse(JSON.parse(content.trim()) as unknown)
  if (!parsed.success) {
    console.error('[llm] response did not match the schema:', parsed.error.message.slice(0, 300))
    return null
  }
  return parsed.data
}

/** Total tokens spent so far, per provider, and when each was last used. The whole report. */
export const usage = (workspaceId: number) =>
  // `prompt` rides along so the page can price input and output apart. Output is four
  // times dearer and this app's spend is ~90% input, so a single blended rate would
  // overstate the bill several times over.
  all<{ provider: string; tokens: number; prompt: number; last_at: string }>(
    `SELECT provider, sum(total_tokens)::int AS tokens, sum(prompt_tokens)::int AS prompt,
            max(created_at) AS last_at
       FROM llm_usage WHERE workspace_id = ? GROUP BY provider ORDER BY last_at DESC`,
    workspaceId,
  )

/**
 * Where the tokens went, which the per-provider total cannot say.
 *
 * A provider total answers "how much" and nothing else — the question it always prompts is
 * "why so much?", and the only honest answer used to be a guess from timestamps. So: what
 * each kind of call cost, how many there were, and what one costs on average.
 *
 * `calls` beside `tokens` is the point. Nine calls at four thousand each and one runaway
 * call at thirty-six thousand are the same total and completely different problems, and the
 * average is what tells them apart at a glance.
 *
 * Rows written before this column existed group under 'unrecorded' rather than being hidden:
 * a total that silently omits them is worse than one that admits what it cannot attribute.
 */
/**
 * Which models ran, and what each was doing.
 *
 * `purposes` is the part worth having beside the total: the same model is cheap answering a
 * question and expensive reading a hundred conversations for training, and a bare list of
 * models cannot tell those apart. Aggregated in SQL rather than fetched per model — one
 * query, however many models a workspace has tried.
 */
export const byModel = (workspaceId: number, sinceDays = 30) =>
  all<{ model: string; calls: number; tokens: number; prompt: number; purposes: string }>(
    `SELECT COALESCE(model, 'unrecorded')        AS model,
            count(*)::int                        AS calls,
            sum(total_tokens)::int               AS tokens,
            sum(prompt_tokens)::int              AS prompt,
            string_agg(DISTINCT COALESCE(purpose, 'other'), ', ' ORDER BY COALESCE(purpose, 'other')) AS purposes
       FROM llm_usage
      WHERE workspace_id = ? AND created_at > now() - make_interval(days => ?)
      GROUP BY 1 ORDER BY tokens DESC`,
    workspaceId,
    sinceDays,
  )

/**
 * What each chatbot spent.
 *
 * Attributed through the conversation rather than stored on the row: `llm_usage` already
 * carries `conversation_id`, and `conversations.bot_id` already says whose thread it is, so
 * a column here would be a third copy of a fact the database can join for.
 *
 * The trade, stated because it is real: reassigning a connection to another bot moves that
 * thread's past spend with it. `agent.ts` deliberately records the bot that *answered* on
 * the conversation for exactly this reason, so the attribution follows that decision rather
 * than contradicting it — but a workspace that reshuffles its bots will see history move.
 *
 * Calls with no conversation — working out what the company does, reading a knowledge base —
 * belong to no bot and are left out rather than spread across them. The page says so, so a
 * share that does not total the workspace's bill is explained rather than puzzling.
 */
export const byBot = (workspaceId: number, sinceDays = 30) =>
  all<{ bot_id: number | null; name: string | null; calls: number; tokens: number; prompt: number }>(
    `SELECT c.bot_id, b.name, count(*)::int AS calls,
            sum(u.total_tokens)::int  AS tokens,
            sum(u.prompt_tokens)::int AS prompt
       FROM llm_usage u
       JOIN conversations c ON c.id = u.conversation_id
       LEFT JOIN bots b     ON b.id = c.bot_id
      WHERE u.workspace_id = ? AND u.created_at > now() - make_interval(days => ?)
      GROUP BY c.bot_id, b.name ORDER BY tokens DESC`,
    workspaceId,
    sinceDays,
  )

export const spend = (workspaceId: number, sinceDays = 30) =>
  all<{ purpose: string; calls: number; tokens: number; prompt: number; per_call: number }>(
    `SELECT COALESCE(purpose, 'unrecorded') AS purpose,
            count(*)::int                   AS calls,
            sum(total_tokens)::int          AS tokens,
            sum(prompt_tokens)::int         AS prompt,
            round(avg(total_tokens))::int   AS per_call
       FROM llm_usage
      WHERE workspace_id = ? AND created_at > now() - make_interval(days => ?)
      GROUP BY 1 ORDER BY tokens DESC`,
    workspaceId,
    sinceDays,
  )
