import type { ReactNode } from 'react'
import { Modal } from './Modal'

/**
 * "This deletes its conversations, and keeps what the bot learned."
 *
 * Every connector's remove button lands here, because every one of them means the same two
 * things and they pull in opposite directions: the threads that arrived on this connection
 * are destroyed, along with the board cards judged from them, and the training already
 * approved from them is not. A `window.confirm` can hold one fact well and two badly, and
 * the second fact is the one that stops somebody believing they are about to lose the work.
 *
 * Order is deliberate. The warning is first because it is the decision, and the reassurance
 * is second because it is what somebody reads last before choosing.
 *
 * `takes` is per connector rather than one generic sentence: a mailbox is not a widget, and
 * "its conversations" is vague in a way that "the emails in this mailbox" is not.
 */
export function ConfirmRemove({
  title,
  note,
  takes,
  confirmLabel,
  busy,
  onConfirm,
  onClose,
}: {
  title: string
  /** One line under the title: what stops working, said plainly. */
  note: string
  /** What this particular connection takes with it, in its own words. */
  takes: ReactNode
  confirmLabel: string
  busy: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Modal title={title} note={note} onClose={onClose}>
      <div className="tip" style={{ marginTop: 0 }}>
        <strong>Its conversations are deleted</strong>
        <p>{takes}</p>
        {/*
          Said separately from `takes`, because it is the same sentence for every connector
          and it is the one somebody does not expect. A card is a judgement read off a
          transcript — which column, why, what they wanted, what they said about price — and
          once the transcript is gone there is nothing left to check it against.
        */}
        <p>
          Anybody left with no conversation at all comes off the project boards, with whatever was worked out
          about them there. Somebody who also wrote in on another channel keeps their card.
        </p>
      </div>
      <div className="tip">
        <strong>Training already approved is kept</strong>
        <p>
          Anything a chatbot has learned and you approved stays on the chatbot. So do the contacts themselves,
          and everything on their profiles — a person is not the channel they wrote in on.
        </p>
      </div>
      <p className="note">This cannot be undone.</p>
      <div className="row">
        {/*
          Named rather than "OK", and the way out says what it does rather than "Cancel".
          At the moment of a destructive choice, both buttons should read as their outcome.
        */}
        <button className="danger" disabled={busy} onClick={onConfirm}>
          {busy ? 'Removing…' : confirmLabel}
        </button>
        <button className="ghost" onClick={onClose}>
          Keep it
        </button>
      </div>
    </Modal>
  )
}
