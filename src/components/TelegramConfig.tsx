import { useState } from 'react'
import { Modal } from './Modal'
import type { Bot } from '../server/channels/telegram'

/**
 * Who is allowed to talk to one bot.
 *
 * A bot's handle is public and anyone who finds it can message it, which cuts both ways. For
 * an internal bot the allow list is the whole security model — an empty one answers nobody.
 * For a support bot being found is the point, and naming every customer in advance is not
 * something its owner can do.
 *
 * So the choice is stated here rather than assumed, closed first, with what each one costs
 * said plainly. Senders the bot has already turned away are offered for the closed case,
 * because that is the only practical way to discover your own numeric Telegram id — or a
 * group's.
 */
export function TelegramConfig({
  bot,
  onClose,
  allow,
  setOpen,
}: {
  bot: Bot
  onClose: () => void
  allow: (arg: { botId: string; sender: string; on: boolean }) => Promise<Bot>
  setOpen: (arg: { botId: string; open: boolean }) => Promise<Bot>
}) {
  const [state, setState] = useState(bot)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const run = async (key: string, work: () => Promise<Bot>) => {
    setBusy(key)
    setError('')
    try {
      setState(await work())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  const act = (key: string, sender: string, on: boolean) => {
    if (!sender.trim()) return
    return run(key, async () => {
      const next = await allow({ botId: bot.id, sender: sender.trim(), on })
      if (on) setTyped('')
      return next
    })
  }

  const reach = (open: boolean) => run(`reach:${open}`, () => setOpen({ botId: bot.id, open }))

  return (
    <Modal
      title={`Who can talk to ${state.label}`}
      note={
        <>
          {state.username ? `@${state.username} ` : 'This bot '}is public — anyone who finds it can message
          it. What happens to a stranger who does is the choice below.
        </>
      }
      onClose={onClose}
    >
      <h4>Who it answers</h4>
      <div className="row" style={{ gap: 8 }}>
        <button className={state.open ? 'ghost small' : 'small'} disabled={!!busy} onClick={() => reach(false)}>
          {busy === 'reach:false' ? 'Closing…' : 'Only the senders I list'}
        </button>
        <button className={state.open ? 'small' : 'ghost small'} disabled={!!busy} onClick={() => reach(true)}>
          {busy === 'reach:true' ? 'Opening…' : 'Anyone who messages it'}
        </button>
      </div>
      <p className="note" style={{ marginTop: 8 }}>
        {state.open ? (
          <>
            <b>Open.</b> Every user and every group that writes in is answered, and each one spends this
            workspace's model budget and can ask what the knowledge base knows. Right for a support bot you
            want customers to find; wrong for an internal one.
          </>
        ) : (
          <>
            <b>Closed.</b> Only the senders listed below are answered; everyone else is turned away and
            recorded here. Nothing reaches a chatbot until you let it through.
          </>
        )}
      </p>

      {/*
        The list is kept while the bot is open, and shown, because closing it again restores
        exactly these people — but it decides nothing meanwhile, and a list that looks like a
        gate while the gate is lifted is the kind of thing somebody leans on by mistake.
      */}
      <h4 style={{ marginTop: 20 }}>
        Allowed {state.open && <span className="note">— not in use while the bot is open</span>}
      </h4>
      {state.allowed.length ? (
        <div className="row" style={{ gap: 6, opacity: state.open ? 0.55 : 1 }}>
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
        <p className={state.open ? 'note' : 'err'} style={{ margin: 0 }}>
          {state.open ? 'Nobody listed — which changes nothing while it answers everyone.' : 'Nobody yet, so this bot answers nothing at all.'}
        </p>
      )}

      {!state.open && state.pending.length > 0 && (
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
          {state.open
            ? 'Answering anyone who writes in.'
            : state.allowed.length
              ? `${state.allowed.length} sender${state.allowed.length === 1 ? '' : 's'} allowed.`
              : 'Nothing is being answered through this bot.'}
        </span>
      </div>
    </Modal>
  )
}
