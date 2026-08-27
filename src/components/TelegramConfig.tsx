import { useState } from 'react'
import { Modal } from './Modal'
import type { Bot } from '../server/channels/telegram'

/**
 * Who is allowed to talk to one bot.
 *
 * A bot's handle is public and anyone who finds it can message it, so this list is the
 * whole security model rather than a convenience: an empty one means the bot answers
 * nobody. Senders it has already turned away are offered here, because that is the only
 * practical way to discover your own numeric Telegram id — or a group's.
 */
export function TelegramConfig({
  bot,
  onClose,
  allow,
}: {
  bot: Bot
  onClose: () => void
  allow: (arg: { botId: string; sender: string; on: boolean }) => Promise<Bot>
}) {
  const [state, setState] = useState(bot)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const act = async (key: string, sender: string, on: boolean) => {
    if (!sender.trim()) return
    setBusy(key)
    setError('')
    try {
      setState(await allow({ botId: bot.id, sender: sender.trim(), on }))
      if (on) setTyped('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  return (
    <Modal
      title={`Who can talk to ${state.label}`}
      note={
        <>
          {state.username ? `@${state.username} ` : 'This bot '}is public — anyone who finds it can message
          it. Only the senders listed here are answered; everything else is turned away.
        </>
      }
      onClose={onClose}
    >
      <h4>Allowed</h4>
      {state.allowed.length ? (
        <div className="row" style={{ gap: 6 }}>
          {state.allowed.map((who) => (
            <button
              key={who}
              className="ghost small"
              title="Stop allowing this sender"
              disabled={busy === who}
              onClick={() => act(who, who, false)}
            >
              {who} ✕
            </button>
          ))}
        </div>
      ) : (
        <p className="err" style={{ margin: 0 }}>
          Nobody yet, so this bot answers nothing at all.
        </p>
      )}

      {state.pending.length > 0 && (
        <>
          <h4 style={{ marginTop: 20 }}>Turned away recently</h4>
          <p className="note" style={{ marginTop: 0 }}>
            Message the bot yourself, or add it to a group and post there, then allow what appears.
          </p>
          <div className="row" style={{ gap: 6 }}>
            {state.pending.map((p) => (
              <button key={p.id} className="small" disabled={busy === p.id} onClick={() => act(p.id, p.id, true)}>
                Allow {p.name} ({p.id})
              </button>
            ))}
          </div>
        </>
      )}

      <h4 style={{ marginTop: 20 }}>Add by hand</h4>
      <div className="row">
        <div style={{ flex: 1, minWidth: 200 }}>
          <input
            aria-label="Allow a sender"
            placeholder="A numeric user id, or a group id"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && act('add', typed, true)}
          />
        </div>
        <button className="ghost" disabled={busy === 'add' || !typed.trim()} onClick={() => act('add', typed, true)}>
          {busy === 'add' ? 'Allowing…' : 'Allow'}
        </button>
      </div>
      <p className="note" style={{ marginTop: 8 }}>
        Ids are numbers rather than handles — a number is all Telegram tells us. A <b>group</b> has its own
        id, which is negative: allow the group and anyone in it can reach the bot.
      </p>

      {error && (
        <p className="err" style={{ marginBottom: 0 }}>
          {error}
        </p>
      )}

      <div className="row" style={{ marginTop: 16 }}>
        <button onClick={onClose}>Done</button>
        <span className="note">
          {state.allowed.length
            ? `${state.allowed.length} sender${state.allowed.length === 1 ? '' : 's'} allowed.`
            : 'Nothing is being answered through this bot.'}
        </span>
      </div>
    </Modal>
  )
}
