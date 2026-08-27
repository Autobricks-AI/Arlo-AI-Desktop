import { useRef, useState } from 'react'
import { Modal } from './Modal'
import type { Bot } from '../server/channels/telegram'

/**
 * Adding a bot: name it, paste the token @BotFather gave you. Verifying the token and
 * registering the webhook happen in the same call, so there is nothing to poll.
 *
 * Nobody can reach a new bot until a sender is allowed on the card — that is deliberate,
 * and the dialog says so before it closes.
 */
export function TelegramModal({
  onClose,
  add,
}: {
  onClose: () => void
  add: (arg: { label: string; token: string }) => Promise<Bot>
}) {
  const [label, setLabel] = useState('')
  const [token, setToken] = useState('')
  const [bot, setBot] = useState<Bot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const running = useRef(false)

  const ready = !!token.trim()

  async function go() {
    // A ref, not `busy`: state only disables the button on the next render, which leaves a
    // window for a second click — and a second click here is a second bot.
    if (running.current || !ready) return
    running.current = true
    setBusy(true)
    setError('')
    try {
      setBot(await add({ label, token }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      running.current = false
      setBusy(false)
    }
  }

  return (
    <Modal
      title={bot ? `${bot.label} is connected` : 'Connect a Telegram bot'}
      note={
        bot
          ? 'One thing left: say who is allowed to talk to it.'
          : 'Talk to @BotFather on Telegram, send /newbot, and paste the token it gives you.'
      }
      onClose={onClose}
    >
      {bot ? (
        <>
          <p style={{ marginTop: 0 }}>
            <b>{bot.label}</b>
            {bot.username && (
              <>
                {' · '}
                <code>@{bot.username}</code>
              </>
            )}
          </p>
          <p className="note" style={{ marginBottom: 0 }}>
            A bot handle is discoverable, so this one answers nobody until you allow a sender. Message it
            yourself, then use <b>Config</b> on the card — whoever it turned away appears there, which is
            also how you find your own Telegram id.
          </p>
          <div className="row" style={{ marginTop: 16 }}>
            <button onClick={onClose}>Done</button>
          </div>
        </>
      ) : (
        <>
          <div className="fields" style={{ gridTemplateColumns: '1fr' }}>
            <div>
              <label htmlFor="tg-label">Name (optional)</label>
              <input
                id="tg-label"
                autoFocus
                maxLength={60}
                value={label}
                placeholder="Support bot, Sales bot…"
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="tg-token">Bot token</label>
              <input
                id="tg-token"
                type="password"
                autoComplete="off"
                value={token}
                placeholder="123456789:AAG…"
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && go()}
              />
            </div>
          </div>
          <div className="row" style={{ marginTop: 16 }}>
            <button disabled={busy || !ready} onClick={go}>
              {busy ? 'Verifying…' : 'Connect bot'}
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
