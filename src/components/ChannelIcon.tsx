/**
 * A small mark per channel.
 *
 * Brand marks from Simple Icons, generic shapes from Lucide, both through `react-icons`.
 * These were hand-drawn SVG until three channels landed at once: approximating the
 * Messenger, Instagram and TikTok marks well enough to be recognisable at 15px is a
 * different job from drawing an envelope, and the previous file had simply not attempted
 * them — all three fell through to the blank-page fallback, which is what the connectors
 * page was showing.
 *
 * The import is per-mark rather than a barrel, so the bundle carries the sixteen glyphs
 * named here and not the rest of the package.
 *
 * Every mark is monochrome and takes `--src` from the same `.src-*` class that tints the
 * card, so a channel's colour is still defined once, in the stylesheet. That loses the
 * two-tone knockouts the drawn versions had — a white handset inside the WhatsApp bubble —
 * which a 15px chip could not really carry anyway.
 */
import type { IconType } from 'react-icons'
import { FaLinkedin } from 'react-icons/fa'
import { LuFile, LuGlobe, LuMail, LuMessageSquare, LuPhone } from 'react-icons/lu'
import { PiMicrosoftOutlookLogo } from 'react-icons/pi'
import { SiDiscord, SiGmail, SiInstagram, SiMessenger, SiTelegram, SiTiktok, SiWhatsapp, SiX } from 'react-icons/si'

/**
 * Keyed by connector id, channel id, or contact-identity kind — the three vocabularies that
 * reach this component, which overlap but are not the same list.
 *
 * Both WhatsApp connectors wear the same mark: it is the same WhatsApp to a customer, and
 * what differs is whose API carries it, which the card already says in words.
 *
 * `facebook` is the Messenger mark rather than the f-in-a-circle, because what a workspace
 * connects is a Page's inbox rather than the Page.
 */
const MARKS: Record<string, IconType> = {
  web: LuMessageSquare,
  website: LuGlobe,
  link: LuGlobe,
  email: LuMail,
  gmail: SiGmail,
  outlook: PiMicrosoftOutlookLogo,
  whatsapp: SiWhatsapp,
  whatsapp_cloud: SiWhatsapp,
  telegram: SiTelegram,
  facebook: SiMessenger,
  instagram: SiInstagram,
  tiktok: SiTiktok,
  linkedin: FaLinkedin,
  discord: SiDiscord,
  x: SiX,
  phone: LuPhone,
}

export function ChannelIcon({ source, size = 15 }: { source: string; size?: number }) {
  // A blank page for anything unrecognised, which is what an unknown channel is.
  const Mark = MARKS[source] ?? LuFile
  return <Mark size={size} aria-hidden className="chicon" style={{ color: 'var(--src, currentColor)' }} />
}
