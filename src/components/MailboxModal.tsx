import { useState } from 'react'
import { Modal } from './Modal'

/**
 * What one mailbox reads.
 *
 * The only setting is how far back to go, because it is the only part nobody can guess for
 * you: the difference between reading this month and reading the last three years. What
 * counts as a question is the app's business and not worth exposing — a mis-typed filter
 * silently stops answering people, which is indistinguishable from nobody writing in.
 */
export function MailboxModal({
  address,
  since,
  onSave,
  onClose,
}: {
  address: string
  since: string
  onSave: (since: string) => Promise<void>
  onClose: () => void
}) {
  const [value, setValue] = useState(since)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const today = new Date().toISOString().slice(0, 10)

  const go = async () => {
    setBusy(true)
    setError('')
    try {
      await onSave(value)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={address} note="How far back this mailbox is read." onClose={onClose}>
      <div className="fields" style={{ gridTemplateColumns: '1fr' }}>
        <div>
          <label htmlFor="since">Read mail received on or after</label>
          <input
            id="since"
            type="date"
            max={today}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && go()}
          />
        </div>
      </div>

      <p className="note" style={{ marginTop: 8 }}>
        Anything older is never fetched. Moving the date back makes the next check reach further — mail
        already filed is recognised and not answered twice, so it is safe to widen. Each check still reads
        at most 20 messages, so a long reach takes a few of them to catch up.
      </p>

      <div className="row" style={{ marginTop: 16 }}>
        <button disabled={busy || !value} onClick={go}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button className="ghost" onClick={onClose}>
          Cancel
        </button>
      </div>

      {error && (
        <p className="err" style={{ marginTop: 12, marginBottom: 0 }}>
          {error}
        </p>
      )}
    </Modal>
  )
}
