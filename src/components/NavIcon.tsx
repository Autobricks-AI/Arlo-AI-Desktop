/**
 * One mark per nav destination, drawn rather than fetched.
 *
 * ponytail: eight glyphs is not worth an icon package. Same approach as ChannelIcon —
 * a 16x16 stroke mark on currentColor, so the rail's colour rules (smoke at rest, moss
 * when active) are decided in the stylesheet and never here.
 */
export type NavMark =
  | 'inbox'
  | 'contacts'
  | 'projects'
  | 'calendar'
  | 'chatbots'
  | 'knowledge'
  | 'connectors'
  | 'settings'
  | 'admin'

export function NavIcon({ mark, size = 16 }: { mark: NavMark; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  } as const

  switch (mark) {
    case 'calendar':
      // A month: the block, its hanging rings, and the rule under the header.
      return (
        <svg {...common}>
          <rect x="2" y="3.5" width="12" height="10.5" rx="1.5" />
          <path d="M2 6.5h12M5.5 2v3M10.5 2v3" />
        </svg>
      )
    case 'inbox':
      // A tray: a box whose top edge is open where the lip crosses it.
      return (
        <svg {...common}>
          <path d="M2 9.5V4a1.5 1.5 0 0 1 1.5-1.5h9A1.5 1.5 0 0 1 14 4v5.5" />
          <path d="M2 9.5h3l1 2h4l1-2h3v2.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12z" />
        </svg>
      )

    case 'contacts':
      // Head and shoulders.
      return (
        <svg {...common}>
          <circle cx="8" cy="5.5" r="2.6" />
          <path d="M2.9 13.6a5.1 5.1 0 0 1 10.2 0" />
        </svg>
      )

    case 'projects':
      // Three bars of differing height: a board seen end-on.
      return (
        <svg {...common}>
          <path d="M3.2 12.8V6.4M8 12.8V3.2M12.8 12.8V8.8" />
        </svg>
      )

    case 'chatbots':
      // The speech bubble, echoing the Arlo mark.
      return (
        <svg {...common}>
          <path d="M13.5 8.4c0 2.7-2.5 4.9-5.5 4.9a6.4 6.4 0 0 1-1.9-.28L3 14l.9-2.5A4.7 4.7 0 0 1 2.5 8.4c0-2.7 2.5-4.9 5.5-4.9s5.5 2.2 5.5 4.9Z" />
        </svg>
      )

    case 'knowledge':
      // An open book: two facing pages over a spine.
      return (
        <svg {...common}>
          <path d="M8 4.6v8.2" />
          <path d="M8 4.6C6.9 3.8 5.5 3.4 3.6 3.4a.9.9 0 0 0-.9.9v6.8c0 .5.4.9.9.9 1.9 0 3.3.4 4.4 1.2" />
          <path d="M8 4.6c1.1-.8 2.5-1.2 4.4-1.2a.9.9 0 0 1 .9.9v6.8c0 .5-.4.9-.9.9-1.9 0-3.3.4-4.4 1.2" />
        </svg>
      )

    case 'connectors':
      // A plug: two prongs into a body.
      return (
        <svg {...common}>
          <path d="M6 2.2v3M10 2.2v3" />
          <path d="M4.2 5.2h7.6v2.4a3.8 3.8 0 0 1-7.6 0z" />
          <path d="M8 11.4v2.4" />
        </svg>
      )

    case 'settings':
      // A slider row: two rails, a handle on each.
      return (
        <svg {...common}>
          <path d="M2.4 5.4h11.2M2.4 10.6h11.2" />
          <circle cx="6" cy="5.4" r="1.7" />
          <circle cx="10.4" cy="10.6" r="1.7" />
        </svg>
      )

    case 'admin':
      // A shield.
      return (
        <svg {...common}>
          <path d="M8 2.2 13 4v4c0 3-2.1 4.9-5 5.8-2.9-.9-5-2.8-5-5.8V4z" />
        </svg>
      )
  }
}
