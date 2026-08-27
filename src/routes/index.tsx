import { createFileRoute, redirect } from '@tanstack/react-router'
import { HOME } from './__root'

/**
 * There is nothing to land on.
 *
 * This used to be a marketing page with a Sign in button, which made sense when the same
 * build served strangers. Arlo Desktop is opened by the one person who installed it, so
 * the front door is the app.
 */
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: HOME })
  },
})
