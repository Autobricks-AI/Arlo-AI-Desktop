/**
 * One mark per nav destination.
 *
 * Lucide through `react-icons`, following ChannelIcon next door — the package is a
 * dependency now, and hand-drawing a second set beside it would be maintaining what is
 * already installed. Each is a stroke mark on currentColor, so the rail's colour rules
 * (smoke at rest, moss when active) stay in the stylesheet and are never decided here.
 */
import type { IconType } from 'react-icons'
import {
  LuBookOpen,
  LuCalendar,
  LuFlaskConical,
  LuFolderOpen,
  LuInbox,
  LuMessageCircle,
  LuPlug,
  LuSlidersHorizontal,
  LuUser,
} from 'react-icons/lu'

export type NavMark =
  | 'inbox'
  | 'contacts'
  | 'calendar'
  | 'chatbots'
  | 'playground'
  | 'knowledge'
  | 'media'
  | 'connectors'
  | 'settings'

/**
 * Exhaustive by type rather than by a `default` case: a new `NavMark` with no glyph is a
 * compile error here, where the switch this replaced would have rendered nothing at all
 * and said so nowhere.
 */
const MARKS: Record<NavMark, IconType> = {
  inbox: LuInbox,
  contacts: LuUser,
  calendar: LuCalendar,
  chatbots: LuMessageCircle,
  playground: LuFlaskConical,
  knowledge: LuBookOpen,
  media: LuFolderOpen,
  connectors: LuPlug,
  settings: LuSlidersHorizontal,
}

export function NavIcon({ mark, size = 16 }: { mark: NavMark; size?: number }) {
  const Mark = MARKS[mark]
  return <Mark size={size} aria-hidden />
}
