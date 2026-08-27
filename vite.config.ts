import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'

/*
 * Bound to loopback only. Nothing here should listen on a public interface: put a proxy in
 * front if it needs to be reachable, and put authentication in that proxy.
 *
 * `allowedHosts` is what lets the dev server answer a request whose Host header is something
 * other than localhost, which is what happens the moment a proxy is in front of it. Add the
 * hostname you reach it by; `.ts.net` covers a Tailscale one.
 */
const PORT = Number(process.env.PORT ?? 9005)
const HOSTS = { host: '127.0.0.1', port: PORT, allowedHosts: ['.ts.net'] }

export default defineConfig({
  server: HOSTS,
  preview: HOSTS,
  plugins: [tanstackStart(), viteReact()],
})
