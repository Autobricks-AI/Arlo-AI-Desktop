import { useState } from 'react'

/**
 * Who the bots say they are answering for.
 *
 * Worked out from the knowledge base rather than asked for — the operator already said who
 * they are by connecting their documents and their site — but editable, because a company
 * whose documents carry its legal name may trade under a shorter one, and it is their name.
 *
 * Workspace-wide rather than per bot: a support bot and a sales bot on the same site work
 * for the same company, and typing it into two boxes is how the two quietly drift apart.
 */
export function CompanyIdentity({
  identity,
  manual,
  documents,
  stale,
  onSave,
  onRederive,
}: {
  identity: string | null
  manual: boolean
  /** How much there is to read. Zero means the button would do nothing, and says so. */
  documents: number
  /** Something has been filed since this line was worked out. */
  stale: boolean
  onSave: (text: string) => Promise<unknown>
  onRederive: () => Promise<unknown>
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(identity ?? '')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    setErr('')
    try {
      await fn()
      setEditing(false)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="card" style={{ marginBottom: 8 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3>Answering for</h3>

          {editing ? (
            <>
              <input
                aria-label="Who this workspace answers for"
                autoFocus
                maxLength={300}
                value={text}
                placeholder="Acme — sells espresso machines in Singapore"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && act('save', () => onSave(text))}
                style={{ marginTop: 6 }}
              />
              <p className="note" style={{ marginBottom: 0 }}>
                A name, and one short line on what the company does. It introduces every bot in this
                workspace; it is never quoted back as an answer. Empty means read it from the knowledge
                base again.
              </p>
            </>
          ) : (
            <>
              <p style={{ margin: '2px 0 0' }}>{identity ?? 'Nothing yet'}</p>
              <p className="note" style={{ margin: 0 }}>
                {manual
                  ? 'You wrote this, so nothing overwrites it.'
                  : !documents
                    ? 'Nothing in the knowledge base yet, so bots answer without a name.'
                    : identity && !stale
                      ? 'Read from your knowledge base, and read again whenever it changes.'
                      : identity
                        ? `Your knowledge base has changed since this was written. ${documents} documents to read again.`
                        : `Not worked out yet — there are ${documents} documents to read.`}
              </p>
            </>
          )}
        </div>

        <div className="acctactions">
          {editing ? (
            <>
              <button disabled={!!busy} onClick={() => act('save', () => onSave(text))}>
                {busy === 'save' ? 'Saving…' : 'Save'}
              </button>
              <button
                className="ghost"
                disabled={!!busy}
                onClick={() => {
                  setText(identity ?? '')
                  setEditing(false)
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button className="ghost" onClick={() => setEditing(true)}>
                Edit
              </button>
              {/*
                Shown whenever there is anything to read, not only when somebody typed over
                it. A knowledge base built after the workspace left this card saying "nothing
                yet" with no way to act on it: the line is only ever worked out when a bot
                answers a message, so a workspace that had not had a conversation could not
                get one at all.
              */}
              {documents > 0 && (
                <button className="ghost" disabled={!!busy} onClick={() => act('rederive', onRederive)}>
                  {busy === 'rederive'
                    ? 'Reading…'
                    : manual
                      ? 'Use the knowledge base'
                      : identity
                        ? 'Read it again'
                        : 'Read the knowledge base'}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {err && (
        <p className="err" style={{ marginBottom: 0 }}>
          {err}
        </p>
      )}
    </div>
  )
}
