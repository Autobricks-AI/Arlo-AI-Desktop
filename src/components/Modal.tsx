import { useEffect, useRef } from 'react'
import type { MouseEvent, ReactNode } from 'react'

/**
 * Close a native `<dialog>` when the click landed outside it.
 *
 * `showModal()` brings a backdrop, a focus trap and Escape-to-close with it, but not this:
 * the backdrop is the dialog's own `::backdrop` pseudo-element rather than a separate node,
 * so a click on it arrives on the dialog element and, by default, does nothing at all. Every
 * sheet in the app is a native dialog, which is why clicking away from one used to feel
 * broken while the connector modals below closed as expected.
 *
 * Measured against the dialog's box rather than trusting the event target alone, because a
 * sheet has padding: a click in that padding is still a click *inside*, and dismissing on it
 * would close the thing somebody was reaching into.
 *
 * `close()` fires the dialog's own `onClose`, so whatever state opened it is put back the
 * same way Escape already puts it back.
 */
export function lightDismiss(e: MouseEvent<HTMLDialogElement>) {
  // A click on a child is never a backdrop click, however the coordinates land — and a
  // keyboard-driven click reports 0,0, which would otherwise read as outside.
  if (e.target !== e.currentTarget) return

  /*
   * A sheet with another sheet open inside it is not the thing being dismissed.
   *
   * Sheets nest now — a file preview opens over the review queue, the attachment picker opens
   * over the editor, and a preview opens over that. The inner one is in the top layer, so its
   * backdrop is what a click outside it lands on, and only the inner one should hear about it.
   * Whatever the browser reports as the target, an ancestor with an open dialog inside it is
   * never what somebody meant to close.
   */
  if (e.currentTarget.querySelector('dialog[open]')) return

  const box = e.currentTarget.getBoundingClientRect()
  const inside =
    e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom
  if (!inside) {
    // One backdrop click closes one dialog, so it does not carry on to whatever is behind.
    e.stopPropagation()
    e.currentTarget.close()
  }
}

/**
 * The shell every connector dialog sits in.
 *
 * One place for the backdrop, the click-outside, the Escape key and the close button, so
 * five dialogs cannot each get one of them subtly wrong.
 */
export function Modal({
  title,
  note,
  onClose,
  children,
}: {
  title: string
  note?: ReactNode
  onClose: () => void
  children: ReactNode
}) {
  return (
    <div
      className="backdrop"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="modal">
        <div className="modalhead">
          <div>
            <h3>{title}</h3>
            {note && (
              <p className="note" style={{ margin: 0 }}>
                {note}
              </p>
            )}
          </div>
          <button className="ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

/**
 * A look at a file without leaving the page it is on.
 *
 * Opening an attachment used to mean a new tab, which loses the conversation you were reading
 * it against — and for the review queue it meant leaving the decision half-made. Images and
 * PDFs render in place; anything a browser will not draw offers a link out, which is the
 * honest version of the same thing.
 *
 * A link is never previewed. It opens in its own tab, because framing somebody else's site
 * inside ours mostly shows an empty box where a refusal header was. Our own files may be
 * framed: they are served sandboxed with `frame-ancestors 'self'`, which is what makes this
 * safe and is set on the attachment and resource routes rather than globally.
 */
export function Peek({
  at,
  onClose,
}: {
  at: { title: string; href: string; mime: string | null }
  onClose: () => void
}) {
  const sheet = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    sheet.current?.showModal()
  }, [])

  const kind = at.mime ?? ''
  return (
    <dialog className="sheet peek" ref={sheet} onClick={lightDismiss} onClose={onClose}>
      <div className="sheetbody">
        {/*
          Its own head rather than the queue's: `.queuehead` is scoped to `.training`, and this
          sheet is opened from the inbox as well, where it inherited no layout at all and the
          close button fell under the title.
        */}
        <div className="peekhead">
          <h3>{at.title}</h3>
          <span className="grow" />
          {/*
            Same origin, so `download` is honoured and names the file what the sender called
            it. The route serves images and PDFs inline for the frame above, which is exactly
            why looking at one gives you no way to keep it without this.
          */}
          <a className="button ghost small" href={at.href} download={at.title}>
            Download
          </a>
          <button type="button" className="ghost small" onClick={onClose}>
            Close
          </button>
        </div>
        {kind.startsWith('image/') ? (
          <img className="peekimg" src={at.href} alt={at.title} />
        ) : kind === 'application/pdf' ? (
          <iframe className="peekdoc" src={at.href} title={at.title} />
        ) : (
          <p className="note">Nothing a browser will draw. Download it to open it here.</p>
        )}
      </div>
    </dialog>
  )
}
