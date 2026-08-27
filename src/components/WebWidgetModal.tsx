import { useRef, useState } from 'react'
import { Modal } from './Modal'

/**
 * Adding a site: name it, then copy the tag.
 *
 * The snippet is shown here rather than only on the card because the moment right after
 * adding one is the moment somebody is going to paste it, and hunting for it in a list of
 * five is a worse first minute than a dialog that hands it over.
 */
export function WebWidgetModal({
  base,
  onClose,
  add,
}: {
  base: string
  onClose: () => void
  add: (label: string) => Promise<{ label: string; key: string }>
}) {
  const [label, setLabel] = useState('')
  const [made, setMade] = useState<{ label: string; key: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const running = useRef(false)

  const snippet = made ? `<script src="${base}/api/widget.js?key=${made.key}" defer></script>` : ''

  async function go() {
    if (running.current) return
    running.current = true
    setBusy(true)
    setError('')
    try {
      setMade(await add(label))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      running.current = false
      setBusy(false)
    }
  }

  return (
    <Modal
      title={made ? `${made.label} is ready` : 'Add a site'}
      note={
        made
          ? 'Paste this before the closing </body> tag on that site.'
          : 'Name it after the site it goes on — that name is how you tell two snippets apart later.'
      }
      onClose={onClose}
    >
      {made ? (
        <>
          <textarea
            readOnly
            value={snippet}
            style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, minHeight: 72 }}
          />
          <p className="note">
            The key is meant to be public — it identifies this widget, and it is not the ingest token,
            which stays secret.
          </p>
          <div className="row">
            <button onClick={() => navigator.clipboard?.writeText(snippet)}>Copy</button>
            <button className="ghost" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : (
        <>
          <label htmlFor="web-label">Name</label>
          <input
            id="web-label"
            autoFocus
            maxLength={60}
            value={label}
            placeholder="Docs site, Storefront…"
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && go()}
          />
          <div className="row" style={{ marginTop: 16 }}>
            <button disabled={busy} onClick={go}>
              {busy ? 'Adding…' : 'Add site'}
            </button>
            <button className="ghost" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}

      {error && (
        <p className="err" style={{ marginTop: 12, marginBottom: 0 }}>
          {error}
        </p>
      )}
    </Modal>
  )
}
