/**
 * Previous and next, shown only when there is somewhere to go.
 *
 * A single-page table gets nothing — controls that are always disabled are furniture, and
 * most of the tables that use this usually have one page.
 *
 * Lifted out of settings.tsx when contacts and the inbox needed the same control. It stayed
 * identical in the move: the arithmetic still lives in `pageOf` (types.ts) for the tables that
 * page in the browser, and in the server query for the ones that page in SQL — this only draws
 * the two buttons and says where you are.
 */
export function Pager({ at, pages, setPage }: { at: number; pages: number; setPage: (n: number) => void }) {
  if (pages < 2) return null
  return (
    <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
      <button className="ghost small" disabled={at === 0} onClick={() => setPage(at - 1)} aria-label="Previous page">
        ‹
      </button>
      <span className="note">
        {at + 1} of {pages}
      </span>
      <button
        className="ghost small"
        disabled={at >= pages - 1}
        onClick={() => setPage(at + 1)}
        aria-label="Next page"
      >
        ›
      </button>
    </div>
  )
}
