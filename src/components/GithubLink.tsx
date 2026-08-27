/**
 * The two places this build points outward: the repository it came from, and the hosted
 * version of the same product.
 *
 * Arlo Desktop is fair-code and the source is the product, so the way to read it should be
 * on the page rather than in a document somebody has to go looking for. Cloud sits beside it
 * because the honest pitch for one is the existence of the other, and the comparison lives
 * in the README either way.
 *
 * Two placements: the sidebar, where they sit with the account, and the sign-in page, which
 * is the only screen somebody sees before they have an account at all.
 *
 * `rel="noreferrer"` as well as `noopener`: these open from a page that is usually on a
 * private address, and the referrer would name it to the other end.
 */
export const REPO = 'https://github.com/Autobricks-AI/Arlo-AI-Desktop'
export const CLOUD = 'https://arlo.autobricks.ai'

/** GitHub's mark, inline. Nothing here loads a font or an icon package for one glyph. */
const Github = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
  </svg>
)

/** A cloud, drawn the way every other icon in this codebase is: strokes on a 16 grid. */
const Cloud = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4.4 12.5a2.9 2.9 0 0 1-.3-5.79 3.9 3.9 0 0 1 7.5-.9 2.85 2.85 0 0 1 .3 5.69Z" />
  </svg>
)

/** The arrow that says "this leaves the app", which a new tab only announces afterwards. */
const Out = () => (
  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4.5 2h5.5v5.5M10 2 4 8M8 10H2V4" />
  </svg>
)

/**
 * In the sidebar, below the account. Styled as nav links so they read as part of the list
 * rather than as advertisements bolted to the bottom of it.
 */
export const OutboundNavLinks = () => (
  <>
    <a className="repo" href={REPO} target="_blank" rel="noopener noreferrer">
      <Github />
      <span>Source on GitHub</span>
      <Out />
    </a>
    <a className="repo" href={CLOUD} target="_blank" rel="noopener noreferrer">
      <Cloud />
      <span>Arlo Cloud</span>
      <Out />
    </a>
  </>
)

/** On the sign-in card, under the form. Quieter, so nothing here competes with the button. */
export const OutboundSignInLinks = () => (
  <div className="repos">
    <a className="repo quiet" href={REPO} target="_blank" rel="noopener noreferrer">
      <Github size={15} />
      <span>Source on GitHub</span>
    </a>
    <a className="repo quiet" href={CLOUD} target="_blank" rel="noopener noreferrer">
      <Cloud size={15} />
      <span>Arlo Cloud</span>
    </a>
  </div>
)
