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

/** Is this address somewhere on our own side of the network? */
export function isPrivateAddress(ip: string): boolean {
  // ::ffff:10.0.0.1 and friends are IPv4 wearing an IPv6 hat.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  if (mapped) return isPrivateAddress(mapped[1])

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
 */
export async function boundedFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ res: Response; body: string }> {
  const { timeoutMs = 20_000, maxBytes = 8 * 1024 * 1024, ...rest } = init

  let target = url
  let res: Response
  for (let hop = 0; ; hop++) {
    res = await fetch(target, { ...rest, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })

    // 301/302/303/307/308. Anything else is the response we came for, redirect or not.
    if (res.status < 300 || res.status >= 400 || !res.headers.get('location')) break
    if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects fetching ${url}`)

    // Resolved against the current URL, per the Location header's own spec — a relative
    // path is common and `new URL` would otherwise throw on it.
    const next = new URL(res.headers.get('location')!, target)
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
  if (!res.body) return { res, body: '' }

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
  return { res, body: new TextDecoder().decode(Buffer.concat(parts)) }
}
