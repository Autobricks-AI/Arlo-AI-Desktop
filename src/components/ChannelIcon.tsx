/**
 * A small mark per channel, drawn rather than fetched.
 *
 * ponytail: no icon dependency and no bundled brand assets — these are simplified marks in
 * the channel's own colour, which is all a 15px chip can carry anyway. They inherit
 * `--src` from the same `.src-*` class that tints the card, so a channel's colour is
 * defined once, in the stylesheet.
 */
export function ChannelIcon({ source, size = 15 }: { source: string; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    'aria-hidden': true,
    className: 'chicon',
    style: { color: 'var(--src, currentColor)' },
  } as const

  if (source === 'gmail' || source === 'email')
    // An envelope with the fold that makes it read as mail rather than a box.
    return (
      <svg {...common}>
        <rect x="1.2" y="3.4" width="13.6" height="9.2" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M1.6 4.2 8 8.9l6.4-4.7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    )

  if (source === 'outlook')
    // The panel-and-envelope shape: a filled block with an O beside a flap.
    return (
      <svg {...common}>
        <rect x="0.8" y="2.6" width="8.4" height="10.8" rx="1.4" fill="currentColor" />
        <ellipse cx="5" cy="8" rx="1.9" ry="2.6" fill="var(--white)" />
        <path d="M10.4 5.2h4.4v5.6h-4.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M10.6 5.6 12.6 7.4 14.6 5.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    )

  if (source === 'whatsapp')
    // A speech bubble with a tail, and the handset inside it.
    return (
      <svg {...common}>
        <path d="M8 1.4a6.5 6.5 0 0 0-5.6 9.8l-.9 3.4 3.5-.9A6.5 6.5 0 1 0 8 1.4Z" fill="currentColor" />
        <path
          d="M5.9 4.9c.13-.3.27-.31.44-.31h.37c.12 0 .28-.04.44.33l.44 1.06c.04.1.07.2 0 .32l-.22.33c-.05.07-.1.14-.04.24.26.44.53.73.94 1.02.36.27.44.21.53.18l.37-.37c.08-.08.15-.06.24-.03l.99.48c.12.06.19.09.22.14.02.06.02.32-.1.62-.11.31-.55.59-.8.61-.23.02-.44.1-1.48-.31-1.13-.44-1.94-1.57-2.01-1.67-.06-.1-.5-.66-.5-1.26 0-.6.32-.9.43-1.02Z"
          fill="var(--white)"
        />
      </svg>
    )

  if (source === 'telegram')
    // A paper plane, with the fold that gives it depth.
    return (
      <svg {...common}>
        <path
          d="M14.7 1.9 1.4 7c-.5.2-.5.6 0 .77l3.3 1.03 1.28 3.9c.1.32.34.4.58.18l1.86-1.6 3.24 2.36c.36.26.75.1.85-.4l2.34-10.8c.1-.47-.2-.72-.55-.55Z"
          fill="currentColor"
        />
        <path d="M5.1 8.9 12 4.4 6.8 9.4l-.2 2.5" fill="none" stroke="var(--white)" strokeWidth="0.9" strokeLinejoin="round" />
      </svg>
    )

  if (source === 'linkedin')
    // The tile with the letters knocked out, which is all that survives at 15px.
    return (
      <svg {...common}>
        <rect x="1.2" y="1.2" width="13.6" height="13.6" rx="2.6" fill="currentColor" />
        <rect x="3.6" y="6.4" width="2" height="6" fill="var(--white)" />
        <circle cx="4.6" cy="4.4" r="1.1" fill="var(--white)" />
        <path d="M7.6 12.4v-6h2v.9c.5-.7 1.2-1 2-1 1.4 0 2.2.9 2.2 2.5v3.6h-2V9.2c0-.8-.3-1.2-1-1.2s-1.2.5-1.2 1.4v3z" fill="var(--white)" />
      </svg>
    )

  if (source === 'website' || source === 'link')
    // A globe: the meridian and the equator are enough to read as one.
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M1.6 8h12.8M8 1.6c3.2 3.4 3.2 9.4 0 12.8M8 1.6C4.8 5 4.8 11 8 14.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    )

  if (source === 'web')
    // A browser window with a chat bubble in it: the widget, not the website.
    return (
      <svg {...common}>
        <rect x="1.2" y="2.4" width="13.6" height="11.2" rx="1.6" fill="currentColor" />
        <path d="M1.4 5.4h13.2" stroke="var(--white)" strokeWidth="1" />
        <path d="M4.6 7.6h6.8v3.2H7.4L5.6 12.2V10.8H4.6z" fill="var(--white)" />
      </svg>
    )

  // Anything else: a page with a folded corner.
  return (
    <svg {...common}>
      <path d="M3.4 1.6h6L13 5.2v9.2H3.4z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M9.2 1.8v3.6h3.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  )
}
