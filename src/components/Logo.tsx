/**
 * The mark: a speech bubble with an "A" cut out of it. The conversation is the container,
 * Arlo is what is inside it — the whole product in one glyph.
 *
 * Solid shapes with an evenodd knockout rather than thin strokes, so it survives a 16px
 * favicon. Inline SVG rather than a file, so it inherits `currentColor` and works on the
 * sand sidebar, the white card and the ink active-link without a second asset.
 */

/** Rounded bubble with a tail at the bottom-left. */
export const BUBBLE =
  'M6.5 2.5H17.5A4.5 4.5 0 0 1 22 7V13A4.5 4.5 0 0 1 17.5 17.5H10L7 20.5V17.5H6.5A4.5 4.5 0 0 1 2 13V7A4.5 4.5 0 0 1 6.5 2.5Z'

/**
 * The "A": one outline plus its counter. Traced as a single contour rather than three
 * overlapping bars — overlapping subpaths would XOR into notches under evenodd.
 */
export const LETTER =
  'M11.25 6.1H12.75L15.6 13.7H13.9L13.35 12.2H10.65L10.1 13.7H8.4Z' + 'M12 8.5L12.91 11H11.09Z'

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={BUBBLE + LETTER} fill="currentColor" fillRule="evenodd" />
    </svg>
  )
}

/**
 * A monitor, for the edition that runs on one.
 *
 * Beside the mark rather than replacing it: the bubble is the product and this says which
 * build of it you are looking at. Strokes rather than the solid shapes above, so the two
 * do not read as one glyph — and a size below the mark's, so the bubble stays first.
 *
 * `aria-hidden` because the word "Desktop" is right next to it; a screen reader announcing
 * both would say the same thing twice.
 */
export function DesktopMark({ size = 15 }: { size?: number }) {
  return (
    <svg
      className="editionmark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2.5" y="4" width="19" height="13" rx="2" />
      <path d="M8.5 20.5h7M12 17.5v3" />
    </svg>
  )
}

/**
 * Same mark for the tab, where `currentColor` means nothing and the knockout would show
 * whatever the browser paints behind it — so the letter is painted, not cut.
 */
export const FAVICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
      `<path d="${BUBBLE}" fill="#171717"/><path d="${LETTER}" fill="#fafafa" fill-rule="evenodd"/></svg>`,
  )
