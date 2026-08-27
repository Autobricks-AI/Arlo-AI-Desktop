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

  const box = e.currentTarget.getBoundingClientRect()
  const inside =
    e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom
  if (!inside) e.currentTarget.close()
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
