/**
 * The production entry. `vite preview` is a development convenience and says so; this is
 * what systemd starts.
 *
 *   node --env-file-if-exists=.env server/prod.mjs
 *
 * One parent, N web workers. The parent does the work that must happen exactly once —
 * migrations now, and later the poller and the WhatsApp sockets — and the workers do
 * nothing but serve. Which of those a process is decides itself, off `cluster.isWorker`;
 * there is no flag to get wrong.
 *
 * Both sides import the same built bundle, so there is one code path and not two. The
 * parent's import is what runs migrate(), and it forks only afterwards, so no worker can
 * serve a request against a schema that has not been applied.
 */
import cluster from 'node:cluster'
import { availableParallelism } from 'node:os'

const BUILD = new URL('../dist/server/server.js', import.meta.url)

const PORT = Number(process.env.PORT ?? 9005)
const HOST = process.env.HOST ?? '127.0.0.1'

/** One core is left to the parent, which with round-robin accepts every connection first. */
const WORKERS = Number(process.env.WEB_WORKERS ?? Math.max(1, Math.min(4, availableParallelism() - 1)))

if (cluster.isPrimary) {
  /*
   * Round-robin, said out loud. It is already the default on Linux, but not on Windows,
   * where the OS decides and in practice hands one worker everything — so a developer
   * checking this locally would measure something production does not do.
   */
  cluster.schedulingPolicy = cluster.SCHED_RR

  // This import is the boot: migrations run and the WhatsApp sockets reconnect as a side
  // effect of it, because this is the process that owns them.
  const { serveSingletons } = await import(BUILD)

  /*
   * A worker that dies is replaced — that is most of why this exists. But a worker that
   * dies *immediately* is a broken build or a bad config, and replacing it forever turns
   * a clear failure into a hot loop that fills the journal. Give up and let systemd's
   * RestartSec do the backing off.
   */
  let quickExits = 0
  let shuttingDown = false

  const fork = () => {
    const worker = cluster.fork()
    const startedAt = Date.now()
    // Teach it how to reach the sockets that live over here.
    serveSingletons(worker)
    worker.on('exit', (code, signal) => {
      if (shuttingDown) return
      const lived = Date.now() - startedAt
      quickExits = lived < 5_000 ? quickExits + 1 : 0
      console.error(`worker ${worker.process.pid} exited (${signal ?? code}) after ${lived}ms`)
      if (quickExits >= 5) {
        console.error('workers are failing to start — giving up so systemd can back off')
        process.exit(1)
      }
      fork()
    })
  }

  const shutdown = (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`${signal}: stopping ${Object.keys(cluster.workers).length} worker(s)`)
    // disconnect() lets each finish what it is holding rather than cutting a response in
    // half; systemd's TimeoutStopSec is the backstop if one will not go.
    for (const worker of Object.values(cluster.workers)) worker.disconnect()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  for (let i = 0; i < WORKERS; i++) fork()
  console.log(`arlo: ${WORKERS} worker(s) on ${HOST}:${PORT}, pid ${process.pid}`)
} else {
  const { createServer } = await import('node:http')
  const { fileURLToPath } = await import('node:url')
  const { default: app } = await import(BUILD)
  const { toNodeHandler } = await import('srvx/node')
  const { serveStatic } = await import('srvx/static')

  /*
   * Something has to serve dist/client, and in this deployment it has to be us — `vite
   * preview` had Vite's static middleware in front of the SSR handler, and that is a
   * development convenience which does not exist here.
   */
  const CLIENT = fileURLToPath(new URL('../dist/client', import.meta.url))
  const assets = serveStatic({ dir: CLIENT })
  const MISS = Symbol('not a static file')

  const fetch = async (request) => {
    try {
      const file = await assets(request, () => MISS)
      if (file !== MISS) {
        /*
         * Vite hashes these filenames from their contents, so a changed file is a changed
         * URL and this can never be stale. Anything not under /assets is named by hand
         * and gets an hour — long enough to be worth caching, short enough to fix.
         */
        file.headers.set(
          'cache-control',
          new URL(request.url).pathname.startsWith('/assets/')
            ? 'public, max-age=31536000, immutable'
            : 'public, max-age=3600',
        )
        return file
      }
      return await app.fetch(request)
    } catch (e) {
      // The framework renders its own error page and answers 500, which is right for the
      // browser and useless for whoever is reading the journal at 3am.
      console.error(`${request.method} ${new URL(request.url).pathname} failed:`, e)
      throw e
    }
  }

  process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e))
  process.on('uncaughtException', (e) => {
    console.error('uncaught exception:', e)
    process.exit(1)
  })

  /*
   * The server is built by hand rather than with srvx's own `serve()`, for one reason:
   * `serve()` listens with `exclusive: true`, and that is precisely the flag that tells
   * cluster not to share the socket. Every worker after the first then gets EADDRINUSE.
   *
   * `trustProxy` is what makes x-forwarded-for and x-forwarded-proto visible to the app.
   * There is a reverse proxy in front and nothing else can reach this port.
   */
  const server = createServer(toNodeHandler(fetch, { trustProxy: true }))

  server.on('error', (e) => {
    // A port already taken has to be loud, or the service looks healthy while something
    // else entirely answers on it.
    console.error(
      e.code === 'EADDRINUSE'
        ? `${HOST}:${PORT} is already in use — something else is serving this port`
        : `listen failed: ${e.message}`,
    )
    process.exit(1)
  })

  server.listen(PORT, HOST, () => console.log(`worker ${process.pid} serving`))

  // Sent by the parent's shutdown: stop accepting, let cluster close the handle when the
  // last connection drains.
  process.on('disconnect', () => server.close(() => process.exit(0)))
}
