import { Link } from '@tanstack/react-router'

/**
 * The one card every `$id` route shows when its id does not resolve — because it was
 * deleted, or because it belongs to a workspace the viewer isn't in right now. Deliberately
 * says both at once rather than picking one: telling them apart would mean confirming a
 * record exists somewhere the viewer cannot see, which is not this page's business to say.
 *
 * Before this there were three different answers to the same question — a route that threw
 * `notFound()`, three that threw a raw `Error` and let it crash to the router's default
 * "Something went wrong!" screen, and one hand-rolled card. One id resolving under the wrong
 * workspace should not look like three different bugs depending which page it happened on.
 */
export function NotFound({ what, to, label }: { what: string; to: string; label: string }) {
  return (
    <div className="page">
      <div className="card">
        <p className="note">
          Can't find that {what}. It may have been removed, or it isn't part of your current workspace.{' '}
          <Link to={to}>{label}</Link>
        </p>
      </div>
    </div>
  )
}
