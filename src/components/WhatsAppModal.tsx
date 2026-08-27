import { useEffect, useRef, useState } from 'react'
import { Modal } from './Modal'
import type { Account } from '../server/channels/whatsapp'

/**
 * Linking a number: name it, then scan the code it produces. The label is asked for up
 * front because a second number is only manageable if you can tell them apart.
 *
 * Reopening an existing link skips straight to the code — WhatsApp wants a scan again
 * whenever the session has been dropped from the phone.
 */
export function WhatsAppModal({
  existing,
  onClose,
  open,
  reopen,
  poll,
}: {
  existing?: Account
  onClose: () => void
  open: (label: string) => Promise<Account>
  reopen: (id: string) => Promise<Account>
  poll: (id: string) => Promise<Account | null>
}) {
  const [label, setLabel] = useState('')
  const [account, setAccount] = useState<Account | null>(existing ?? null)
  // Reopening starts a socket on mount, so begin busy — otherwise the first frame reads
  // the account's stale 'off' status as a failure.
  const [busy, setBusy] = useState(!!existing)
  const [error, setError] = useState('')
  const running = useRef(false)

  useEffect(() => {
    if (existing) void go(() => reopen(existing.id))
  }, [])

  // A QR code is replaced every few seconds and the scan lands on the server, not here, so
  // the only way this dialog learns it worked is by asking.
  useEffect(() => {
    if (!account || account.status === 'online' || account.status === 'off') return
    const t = setInterval(async () => setAccount((await poll(account.id)) ?? account), 2000)
    return () => clearInterval(t)
  }, [account?.id, account?.status])

  async function go(fn: () => Promise<Account>) {
    // A ref, not `busy`: state disables the button only on the next render, and in dev
    // StrictMode runs the mount effect twice.
    if (running.current) return
    running.current = true
    setBusy(true)
    setError('')
    try {
      setAccount(await fn())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      running.current = false
      setBusy(false)
    }
  }

  const online = account?.status === 'online'

  return (
    <Modal
      title={online ? 'WhatsApp linked' : account ? `Link ${account.label}` : 'Link a WhatsApp number'}
      note={
        online
          ? 'Questions sent to this number can be read and answered from now on — once you pick the chats.'
          : account?.qr
            ? 'Scan this from the phone that owns the number. Have the phone ready — codes expire.'
            : !busy && account?.status === 'off'
              ? 'Codes are short-lived, so this one is no longer valid.'
              : account
                ? 'Asking WhatsApp for a pairing code.'
                : 'Name it first — the label is how you tell your numbers apart later.'
      }
      onClose={onClose}
    >
      {online ? (
        <>
          <p style={{ marginTop: 0 }}>
            <b>{account.label}</b>
            {account.phone && (
              <>
                {' · '}
                <code>+{account.phone}</code>
              </>
            )}
          </p>
          <p className="note">
            Nothing is read yet: this socket can see every chat on the number, so pick the ones Arlo may
            read with <b>Config</b> on the card.
          </p>
          {/*
            Said at the one moment somebody is looking at a freshly linked number.

            The history that arrives with a link is filed but deliberately not read for
            training: a few hundred backfilled chats would be a model call each, twice over —
            once for training and once for the board — and an approval queue nobody asked for,
            triggered by scanning a code. It is opt-in instead, and this is where to say so,
            because the alternative is somebody concluding weeks later that training is broken.

            The threads are trainable, and the wording has to carry that: "not read yet" and
            "cannot be used" are the same sentence to a reader in a hurry, and only one of
            them is true.
          */}
          <div className="tip">
            <strong>The chats already on this number are not learned from automatically</strong>
            <p>
              Everything on the phone is filed so you can read it, but Arlo will not train on it on its own —
              a few hundred old chats read at once is a bill and an approval queue nobody asked for. Any of
              them can still teach it: open a conversation in the <b>Inbox</b> and use <b>Learn from this ›
              the whole conversation</b>. New messages from here on are read as normal.
            </p>
          </div>
          <div className="row">
            <button onClick={onClose}>Done</button>
          </div>
        </>
      ) : account ? (
        <>
          {account.qr ? (
            <img
              src={account.qr}
              alt="WhatsApp pairing QR code"
              width={260}
              height={260}
              style={{ display: 'block', borderRadius: 6, border: '1px solid var(--line)' }}
            />
          ) : (
            <p className="note" style={{ marginTop: 0 }}>
              {!busy && account.status === 'off' ? (
                <>
                  That code expired before it was scanned.{' '}
                  <button className="ghost small" onClick={() => go(() => reopen(account.id))}>
                    Get a new code
                  </button>
                </>
              ) : (
                'Getting a code…'
              )}
            </p>
          )}
          <ol style={{ marginTop: 16, marginBottom: 0 }}>
            <li>
              Open <b>WhatsApp</b> on the phone{account.qr ? '' : ' now, while this loads'}.
            </li>
            <li>
              Go to <b>Settings → Linked devices → Link a device</b>.
            </li>
            <li>Point it at the code. A fresh one appears every few seconds.</li>
          </ol>
        </>
      ) : (
        <>
          <label htmlFor="wa-label">Name</label>
          <input
            id="wa-label"
            autoFocus
            maxLength={60}
            value={label}
            placeholder="Support line, Sales phone…"
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && label.trim() && go(() => open(label))}
          />
          <div className="row" style={{ marginTop: 16 }}>
            <button disabled={busy || !label.trim()} onClick={() => go(() => open(label))}>
              {busy ? 'Getting a code…' : 'Get QR code'}
            </button>
            <button className="ghost" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}

      {(error || account?.error) && (
        <p className="err" style={{ marginTop: 12, marginBottom: 0 }}>
          {error || account?.error}
        </p>
      )}
    </Modal>
  )
}
