import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClipboardEvent, DragEvent } from 'react'
import { CHAT_FILE, CHAT_FILE_ACCEPT, MAX_RESOURCE_MB } from '../types'

/**
 * Putting a picture or a PDF into a chat box.
 *
 * Three ways in, because a person about to send a screenshot will reach for whichever one is
 * already in their hands: the paperclip, a drag from the desktop, or — far more often than
 * either — Ctrl+V straight after a screen grab. The last one is the whole reason this exists;
 * a composer that takes a file only through a file dialog makes somebody save a screenshot to
 * disk first, find it, and pick it, to send a thing they already had on the clipboard.
 *
 * Shared because the inbox and the playground need exactly the same behaviour and the same
 * refusals, and two copies of a paste handler is two places for the size check to drift out of
 * step with the one on the server.
 *
 * It holds `File` objects and nothing else. What happens to them on send is the composer's
 * business and the two differ completely — the inbox puts them in the library and sends ids,
 * the playground sends the bytes and keeps nothing.
 */

/** What went wrong, in words a person can act on, or null when the file is fine. */
function refuse(file: File): string | null {
  // A screenshot off the clipboard is 'image/png' with no name; a file dialog always names one.
  if (!CHAT_FILE.test(file.type)) return `${file.name || 'That file'} is ${file.type || 'an unknown type'} — send a picture or a PDF`
  if (file.size > MAX_RESOURCE_MB * 1048576)
    return `${file.name || 'That file'} is ${Math.round(file.size / 1048576)}MB, over the ${MAX_RESOURCE_MB}MB limit`
  return null
}

/** A pasted screenshot arrives unnamed. Give it one, so a chip and a prompt can say which. */
const named = (file: File) =>
  file.name ? file : new File([file], `screenshot-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.png`, { type: file.type })

/**
 * @param onFiles What to do with files that passed the check. Left out, they are held here
 *   until the composer sends them — which is what the playground wants, because its files
 *   never become rows anywhere. The inbox passes an uploader instead: a file there goes to
 *   the library first and the composer only ever carries its id.
 */
export function useChatFiles(onError: (message: string) => void, onFiles?: (files: File[]) => void) {
  const [files, setFiles] = useState<File[]>([])
  const [dragging, setDragging] = useState(false)
  const picker = useRef<HTMLInputElement>(null)

  const take = useCallback(
    (incoming: FileList | File[] | null | undefined) => {
      const list = [...(incoming ?? [])]
      if (!list.length) return false
      const bad = list.map(refuse).find(Boolean)
      if (bad) {
        onError(bad)
        // Still handled: the paste was a file, it was simply the wrong one, and letting it
        // fall through would also drop the file's name into the message as text.
        return true
      }
      onError('')
      const kept = list.map(named)
      if (onFiles) onFiles(kept)
      else setFiles((f) => [...f, ...kept])
      return true
    },
    [onError, onFiles],
  )

  return {
    files,
    picker,
    dragging,
    clear: () => setFiles([]),
    remove: (at: number) => setFiles((f) => f.filter((_, i) => i !== at)),
    open: () => picker.current?.click(),
    take,
    /** Spread onto whatever wraps the composer: the textarea alone is too small a target. */
    bind: {
      onPaste: (e: ClipboardEvent) => {
        /*
         * Only when there is actually a file. A normal text paste also carries a clipboard
         * with no files, and swallowing that would stop people pasting an address in.
         */
        if (take(e.clipboardData?.files)) e.preventDefault()
      },
      onDragOver: (e: DragEvent) => {
        e.preventDefault()
        setDragging(true)
      },
      onDragLeave: () => setDragging(false),
      onDrop: (e: DragEvent) => {
        e.preventDefault()
        setDragging(false)
        take(e.dataTransfer?.files)
      },
    },
  }
}

/**
 * What is about to be sent, and the way to add more.
 *
 * A picture shows itself — at chip size that is the only label worth having, since five
 * screenshots taken a minute apart have five indistinguishable names.
 */
export function Attached({
  files,
  onRemove,
  onPick,
  picker,
  disabled,
}: {
  files: File[]
  onRemove: (at: number) => void
  onPick: (list: FileList | null) => void
  picker: React.RefObject<HTMLInputElement | null>
  disabled?: boolean
}) {
  return (
    <>
      <input
        ref={picker}
        type="file"
        accept={CHAT_FILE_ACCEPT}
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          onPick(e.target.files)
          // Otherwise picking the same file twice fires no change event the second time.
          e.target.value = ''
        }}
      />
      {!!files.length && (
        <div className="chline attached">
          {files.map((file, at) => (
            <span key={`${file.name}-${at}`} className="pill">
              {file.type.startsWith('image/') && <Thumb file={file} />}
              {file.name}
              <button className="chipx" aria-label={`Remove ${file.name}`} disabled={disabled} onClick={() => onRemove(at)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </>
  )
}

/** A chip-sized look at a file that has not been uploaded yet, straight off the clipboard. */
function Thumb({ file }: { file: File }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    const made = URL.createObjectURL(file)
    setUrl(made)
    // Revoked on the way out, or every paste leaks a blob for as long as the tab is open.
    return () => URL.revokeObjectURL(made)
  }, [file])
  return url ? <img className="chipthumb" src={url} alt="" /> : null
}
