/**
 * Reaching somebody else's server, safely.
 *
 * A URL somebody typed into a form is a request to make this server fetch something. Left
 * unchecked that is a proxy into whatever the server can reach and the browser cannot —
 * the metadata endpoint, the database, the admin panel on the next port. So the address
 * is resolved and checked before anything is sent to it.
 *
 * SCRAPE_ALLOW_HOSTS is the escape hatch, not the gate: public addresses are allowed by
 * default, because a workspace crawling its own public website is the entire point of the
 * feature. Naming a host there is how an operator says "this internal one is fine too".
 *
 * ponytail: the address is resolved and checked, then fetch resolves it again — so a name
 * that answers with a public address once and a private one a moment later (DNS
 * rebinding) gets through. Closing that means connecting to the checked IP and carrying
 * the hostname for TLS, which is a lot of machinery for a threat needing an
 * attacker-controlled DNS server. Revisit if this ever accepts URLs from anonymous users.
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/** Internal hosts an operator has explicitly decided this server may reach. */
const allowed = () =>
  new Set(
    (process.env.SCRAPE_ALLOW_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  )

const v4 = (ip: string) => ip.split('.').map(Number)

/**
 * The IPv4 hiding inside an IPv4-mapped IPv6 address, in dotted form, or null.
 *
 * There are two spellings and they mean the same address: `::ffff:169.254.169.254` and
 * `::ffff:a9fe:a9fe`. Matching only the first is the whole bug this function exists to close —
 * `a9fe:a9fe` *is* 169.254.169.254, `isIP()` calls it a 6 so the IPv4 branch never runs, and
 * none of the IPv6 prefixes below match a string starting `::ffff:`, so the cloud metadata
 * endpoint came back judged public. `::ffff:7f00:1`, `::ffff:0a00:0001` and the tailnet range
 * all went the same way.
 *
 * So this reads the low 32 bits rather than pattern-matching the text: any `::ffff:` address is
 * normalised to dotted quad and re-judged as the IPv4 it is, whichever way it was written.
 */
function mappedV4(ip: string): string | null {
  const m = /^::ffff:(.+)$/i.exec(ip)
  if (!m) return null
  const rest = m[1]

  // Already dotted — hand it back as it stands.
  if (isIP(rest) === 4) return rest

  // Two hex groups, high word first: ::ffff:a9fe:a9fe
  const pair = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(rest)
  if (!pair) return null
  const hi = parseInt(pair[1], 16)
  const lo = parseInt(pair[2], 16)
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.')
}

/** Is this address somewhere on our own side of the network? */
export function isPrivateAddress(ip: string): boolean {
  // ::ffff:10.0.0.1 and friends are IPv4 wearing an IPv6 hat, in either spelling.
  const mapped = mappedV4(ip)
  if (mapped) return isPrivateAddress(mapped)

  if (isIP(ip) === 4) {
    const [a, b] = v4(ip)
    if (a === 0 || a === 127) return true // this host, loopback
    if (a === 10) return true // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true // RFC1918
    if (a === 192 && b === 168) return true // RFC1918
    if (a === 169 && b === 254) return true // link-local, and where cloud metadata lives
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT, incl. Tailscale
    if (a >= 224) return true // multicast and reserved
    return false
  }

  const s = ip.toLowerCase()
  if (s === '::' || s === '::1') return true // unspecified, loopback
  if (/^fe[89ab]/.test(s)) return true // fe80::/10 link-local
  if (/^f[cd]/.test(s)) return true // fc00::/7 unique-local, incl. tailscale
  if (s.startsWith('ff')) return true // multicast
  return false
}

/**
 * Check a user-supplied URL before anything is sent to it. Throws with a message meant
 * for whoever typed the URL, since that is where it is shown.
 */
export async function assertReachable(raw: string) {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${raw} is not a valid URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('The address must start with http:// or https://')

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (allowed().has(host)) return url

  // A literal address needs no lookup; a name does, and it is the resolved address that
  // decides — otherwise `intranet.example.com` resolving to 10.0.0.5 sails through.
  const addresses = isIP(host)
    ? [host]
    : await lookup(host, { all: true, verbatim: true })
        .then((rs) => rs.map((r) => r.address))
        .catch(() => {
          throw new Error(`Could not resolve ${host}`)
        })

  if (!addresses.length) throw new Error(`Could not resolve ${host}`)

  // Every address, not the first: a name that answers with one public and one private
  // address is the same attack with an extra step.
  const blocked = addresses.find((a) => isPrivateAddress(a))
  if (blocked)
    throw new Error(
      `${host} resolves to ${blocked}, which is on this server's own network. ` +
        `If that is genuinely where the page lives, add ${host} to SCRAPE_ALLOW_HOSTS on the server.`,
    )

  return url
}

/** A redirect chain has to end somewhere; five hops is generous for a real site. */
const MAX_REDIRECTS = 5

/**
 * Headers that authenticate *us* rather than describe the request, dropped the moment a
 * redirect changes origin.
 *
 * `fetch` carries custom headers across a cross-origin redirect, so a URL that arrived in a
 * webhook body and answers `302 Location: https://somewhere-else/` is handed this instance's
 * access token or API key by whatever host it names. Unconditional and without a flag: it is
 * what a browser does and what `curl` does without `--location-trusted`, and a caller who
 * genuinely wants the header on the second host can make the second call themselves.
 */
const CREDENTIALS = ['authorization', 'x-api-key', 'access-token', 'cookie']

/**
 * fetch with the two bounds a call to somebody else's server needs: it has to give up,
 * and it has to stop reading. Without the first a dead host holds the request forever;
 * without the second the response size is whatever the far end feels like sending.
 *
 * The third bound is the one that matters most: every hop of a redirect is re-checked
 * against `assertReachable` before it is followed. `fetch`'s default `redirect: 'follow'`
 * checks none of them — `assertReachable` validated the URL a user typed, and a page on
 * their own site can send this server anywhere with a 302. The cloud metadata endpoint
 * answers `text/plain`, which is exactly the shape a scrape stores and a bot later quotes,
 * so an unchecked redirect is not a crash, it is exfiltration into the knowledge base.
 *
 * A hop that changes origin also drops the credential headers — see `CREDENTIALS`.
 *
 * Both forms of the body come back: `bytes` is what arrived, `body` is that decoded as UTF-8
 * and computed only if something asks for it. A media fetch wants the first — `TextDecoder`
 * mangles every image, audio file and PDF it touches — and a scrape wants the second, and
 * neither is worth a second copy of the redirect loop, which is a second place to forget the
 * origin check.
 */
export async function boundedFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ res: Response; body: string; bytes: Buffer }> {
  const { timeoutMs = 20_000, maxBytes = 8 * 1024 * 1024, ...rest } = init

  // One mutable copy, so a header dropped at one hop stays dropped for the rest of them.
  const headers = new Headers(rest.headers as HeadersInit | undefined)

  let target = url
  let res: Response
  for (let hop = 0; ; hop++) {
    res = await fetch(target, { ...rest, headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })

    // 301/302/303/307/308. Anything else is the response we came for, redirect or not.
    if (res.status < 300 || res.status >= 400 || !res.headers.get('location')) break
    if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects fetching ${url}`)

    // Resolved against the current URL, per the Location header's own spec — a relative
    // path is common and `new URL` would otherwise throw on it.
    const next = new URL(res.headers.get('location')!, target)
    if (next.origin !== new URL(target).origin) for (const h of CREDENTIALS) headers.delete(h)
    await res.body?.cancel().catch(() => {})
    // The check the redirect itself has to pass, not only the URL a user typed.
    target = (await assertReachable(next.href)).href
  }

  // Believe content-length when it is offered, but do not rely on it: it is a claim.
  const declared = Number(res.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel()
    throw new Error(`That page is ${Math.round(declared / 1048576)}MB, over the ${Math.round(maxBytes / 1048576)}MB limit`)
  }
  if (!res.body) return { res, body: '', bytes: Buffer.alloc(0) }

  // Read it ourselves so the cap holds whether or not content-length was honest.
  const reader = res.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > maxBytes) {
      await reader.cancel()
      throw new Error(`That page is over the ${Math.round(maxBytes / 1048576)}MB limit`)
    }
    parts.push(value)
  }
  const bytes = Buffer.concat(parts)
  // Decoded on demand: every existing caller wants the text, and a caller that wanted an
  // image would otherwise pay for a megabyte-long string it never reads.
  let text: string | null = null
  return {
    res,
    bytes,
    get body() {
      return (text ??= new TextDecoder().decode(bytes))
    },
  }
}
