import { useEffect, useState } from 'react'
import type { MouseEvent } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { requireSession } from '../server/auth'
import * as customers from '../server/customers'
import { ChannelIcon } from '../components/ChannelIcon'
import { Pager } from '../components/Pager'
import { CONTACTS_PAGE, displayName, when } from '../types'

/**
 * Everyone who has ever written in.
 *
 * Nothing is added here by hand and there is no "new contact" button, deliberately: a
 * contact exists because somebody sent a message, and one that exists for any other reason
 * is a row nobody can answer. `identify()` writes them the moment a message arrives, on
 * whatever channel — this page is the reading end of that.
 *
 * One page at a time, searched in SQL. It used to load every contact in the workspace and
 * filter them in the browser, which was written down here as fine into the low thousands —
 * and then a workspace reached 1,187 contacts, each one a 31-column record carrying an
 * AI-written summary this page never draws. See `customers.list`.
 */
const load = createServerFn({ method: 'GET' })
  .validator((d: { find: string; page: number }) => d)
  .handler(async ({ data }) =>
    customers.list((await requireSession()).workspaceId, { find: data.find, page: data.page }),
  )

export const Route = createFileRoute('/contacts')({
  /*
   * The search and the page live in the URL, like every other stateful page here: a list
   * worth looking at is a list worth sending somebody, and a reload should not lose your
   * place. The default page is the absent parameter, so a bare /contacts is page one.
   */
  validateSearch: (q: Record<string, unknown>): { find?: string; page?: number } => ({
    find: typeof q.find === 'string' && q.find.trim() ? q.find.slice(0, 120) : undefined,
    page: Number(q.page) > 1 ? Math.floor(Number(q.page)) : undefined,
  }),
  loaderDeps: ({ search }) => ({ find: search.find ?? '', page: search.page ?? 1 }),
  // One-based in the URL because that is what the pager shows; zero-based past here.
  loader: ({ deps }) => load({ data: { find: deps.find, page: deps.page - 1 } }),
  component: Contacts,
})


function Contacts() {
  const { rows, total } = Route.useLoaderData()
  const { find: urlFind = '', page = 1 } = Route.useSearch()
  const navigate = useNavigate()
  const routeNavigate = Route.useNavigate()

  /*
   * The box holds what you typed; the URL holds what was searched.
   *
   * They are two different things now that a keystroke costs a round trip. Typing updates the
   * box immediately and the URL a quarter of a second after you stop — without that, every
   * letter of a name is its own query and its own history entry. `replace` for the same
   * reason: a search is a view of this page, not eleven places to go back to.
   */
  const [typed, setTyped] = useState(urlFind)
  useEffect(() => {
    if (typed === urlFind) return
    const t = setTimeout(
      () => void routeNavigate({ search: { find: typed.trim() || undefined }, replace: true }),
      250,
    )
    return () => clearTimeout(t)
  }, [typed, urlFind, routeNavigate])

  // The URL changing under us — a back button, a shared link — should be reflected in the box.
  useEffect(() => setTyped(urlFind), [urlFind])

  const pages = Math.max(1, Math.ceil(total / CONTACTS_PAGE))
  const at = Math.min(Math.max(0, page - 1), pages - 1)
  const setPage = (n: number) =>
    void routeNavigate({ search: (prev) => ({ ...prev, page: n > 0 ? n + 1 : undefined }) })

  /**
   * Anywhere on the row opens the person, not just their name.
   *
   * The name stays a real link underneath this, which is what keyboards, middle-clicks and
   * "open in new tab" use — this only adds the rest of the row for a mouse.
   *
   * Two things a row must not swallow. A board pill is its own link to somewhere else, and
   * an email or a phone number in these columns is there to be selected and copied — so a
   * click that finished a selection is somebody copying, not somebody navigating.
   */
  const open = (id: number) => (e: MouseEvent<HTMLTableRowElement>) => {
    if ((e.target as HTMLElement).closest('a, button')) return
    if (window.getSelection()?.toString()) return
    void navigate({ to: '/contact/$id', params: { id: String(id) } })
  }

  // Nothing at all, versus nothing matching — a different sentence and a different fix.
  const empty = total === 0 && !urlFind

  return (
    <>
      <h1>Contacts</h1>
      <p className="lede">
        Everyone who has written in, on any channel. They are saved the moment they send their first
        message — there is nothing to add by hand.
      </p>

      {!empty && (
        <div className="row" style={{ marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
          <input
            className="search"
            aria-label="Search contacts"
            placeholder="Search by name, address, number or anything Arlo has learned"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          {/* The count is of everything matching, not of what is on screen — a total that
              only counts the visible page is the kind of number people plan around and
              should not. */}
          <span className="note">
            {total} {total === 1 ? 'contact' : 'contacts'}
            {urlFind ? ' matching' : ''}
          </span>
        </div>
      )}

      {empty ? (
        <div className="card">
          <p className="note" style={{ margin: 0 }}>
            Nobody yet. The first person to use the web widget, message a bot or write to a connected
            mailbox appears here.
          </p>
        </div>
      ) : (
        <>
          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Company</th>
                  <th>Reached on</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th className="num">Conversations</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="click" onClick={open(c.id)}>
                    <td>
                      <Link to="/contact/$id" params={{ id: String(c.id) }}>
                        {displayName(c)}
                      </Link>
                      {c.do_not_contact && (
                        <span className="pill bad" style={{ marginLeft: 6 }}>
                          do not contact
                        </span>
                      )}
                      {(c.tags ?? []).length > 0 && (
                        <span className="note" style={{ display: 'block' }}>
                          {(c.tags ?? []).join(' · ')}
                        </span>
                      )}
                    </td>
                    <td>
                      {c.company ?? ''}
                      {c.job_title && (
                        <span className="note" style={{ display: 'block' }}>
                          {c.job_title}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="chline">
                        {c.channels.map((channel) => (
                          <span key={channel} className={`src-${channel}`} title={channel}>
                            <ChannelIcon source={channel} size={14} />
                          </span>
                        ))}
                      </span>
                    </td>
                    <td>{c.email ?? ''}</td>
                    <td>{c.phone ? `+${c.phone}` : ''}</td>
                    <td className="num">{c.conversations}</td>
                    <td>{when(c.last_seen_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && (
              <p className="note" style={{ padding: 16, margin: 0 }}>
                Nobody matches “{urlFind}”.
              </p>
            )}
          </div>

          <Pager at={at} pages={pages} setPage={setPage} />
        </>
      )}
    </>
  )
}
