import { useState } from 'react'
import type { MouseEvent } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { requireSession } from '../server/auth'
import * as customers from '../server/customers'
import { ChannelIcon } from '../components/ChannelIcon'
import { displayName, when } from '../types'

/**
 * Everyone who has ever written in.
 *
 * Nothing is added here by hand and there is no "new contact" button, deliberately: a
 * contact exists because somebody sent a message, and one that exists for any other reason
 * is a row nobody can answer. `identify()` writes them the moment a message arrives, on
 * whatever channel — this page is the reading end of that.
 *
 * ponytail: the whole list, filtered in the browser. Fine into the low thousands, which is
 * a year of a busy support desk; past that it wants a LIMIT and the search moved into SQL.
 */
const load = createServerFn({ method: 'GET' }).handler(async () => ({
  contacts: await customers.list((await requireSession()).workspaceId),
}))

export const Route = createFileRoute('/contacts')({ loader: () => load(), component: Contacts })


function Contacts() {
  const { contacts } = Route.useLoaderData()
  const navigate = useNavigate()
  const [find, setFind] = useState('')

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

  const needle = find.trim().toLowerCase()
  const shown = needle
    ? contacts.filter((c) =>
        [c.name, c.first_name, c.last_name, c.company, c.email, c.phone, c.city, c.country, c.owner,
         ...(c.tags ?? []), ...Object.values(c.traits ?? {})]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(needle)),
      )
    : contacts

  return (
    <>
      <h1>Contacts</h1>
      <p className="lede">
        Everyone who has written in, on any channel. They are saved the moment they send their first
        message — there is nothing to add by hand.
      </p>

      {contacts.length > 0 && (
        <input
          aria-label="Search contacts"
          placeholder="Search by name, address, number or anything Arlo has learned"
          value={find}
          onChange={(e) => setFind(e.target.value)}
          style={{ maxWidth: 420, marginBottom: 12 }}
        />
      )}

      {contacts.length === 0 ? (
        <div className="card">
          <p className="note" style={{ margin: 0 }}>
            Nobody yet. The first person to use the web widget, message a bot or write to a connected
            mailbox appears here.
          </p>
        </div>
      ) : (
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
              {shown.map((c) => (
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
          {!shown.length && (
            <p className="note" style={{ padding: 16, margin: 0 }}>
              Nobody matches “{find}”.
            </p>
          )}
        </div>
      )}
    </>
  )
}
