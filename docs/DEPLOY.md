# Operating it

The README gets Arlo running on your own machine, where `docker compose up -d` and a
loopback port are the whole story. This file is for the case where that is not enough: the
container is on a VPS, a home server or a NAS, and somebody other than you can reach it.

Nothing here replaces the install. It is the same image and the same Compose file:
substitute your own hostname.

---

## First, the thing that is not optional

**Read [the sign-in section of the README](../README.md).** There is one account and one
password in this build, no roles and no multi-user anything, and the default password is
published. Putting this on a network means changing it, and then putting something in front
of it that asks who you are.

`docker-compose.yml` publishes both ports to `127.0.0.1` for exactly this reason. Docker's
port publishing bypasses the host firewall, so changing `127.0.0.1:9005:9005` to `9005:9005`
genuinely exposes the app (with no certificate and no proxy), to everything that can route
to the machine.

## The reverse proxy

Terminate TLS at the proxy and forward to `127.0.0.1:9005`. `server/prod.mjs` passes
`trustProxy` to srvx, so it reads `x-forwarded-proto` and marks its session cookie `Secure`
correctly, but only if the proxy actually sends it. Whatever you use needs to pass `Host`
and `X-Forwarded-Proto` through. A minimal Caddy config is the whole of it:

```
arlo.example.com {
    reverse_proxy 127.0.0.1:9005
}
```

**This is also where authentication goes.** Basic auth at the proxy, an identity-aware
proxy, or a tailnet: any of them is more than the app provides on its own.

## `PUBLIC_URL`

Set it in `.env` to the address a browser will actually type, and restart:

```ini
PUBLIC_URL=https://arlo.example.com
```

The widget snippet, Telegram webhook addresses and OAuth redirects are all built from it, so
a wrong value does not fail loudly: it produces addresses nobody can reach. It is also what
lets Telegram use a webhook instead of polling; see `TELEGRAM_POLLING` in `.env.example`.

## The database connection

Compose puts Postgres on the same private network as the app and nothing else can reach it,
so the connection between them is plaintext and that is fine.

Pointing `DATABASE_URL` at a Postgres somewhere else is a different situation, and
`DATABASE_CA_CERT` is what makes that connection verify: give it the path to the server's CA
certificate, or the PEM itself. Without it the driver refuses to guess and runs unverified,
which is only defensible on loopback.

## Checking it

```bash
docker compose exec app npm run preflight
```

Reports what is configured and what is not: the database roles, whether the app role can
bypass row-level security (it must not), TLS on the database connection, and whether the
port is private. It is read-only.

Then, by hand: open it, sign in, upload a document, and ask the widget a question. The tests
are all server-side and say nothing about whether the thing works in a browser.

## Upgrading

```bash
git pull
docker compose up -d --build
```

Migrations are applied once each and never edited, and `server/prod.mjs` applies them at
boot before it forks a single worker, so there is no window where a request is served
against a schema that has not caught up.

## Backups

Everything is in Postgres except two directories, and only one of them matters:

- `.wa-auth/`: WhatsApp session keys. Losing these means scanning the QR code again.
- the OCR language cache: rebuilt automatically, not worth backing up.

So a `pg_dump` plus `.wa-auth/` is the whole backup.

```bash
docker compose exec db pg_dump -U arlo_owner arlo | gzip > arlo-$(date +%F).sql.gz
docker run --rm -v arlo-ai_arlo-wa:/wa -v "$PWD:/out" alpine \
  tar czf /out/arlo-wa-$(date +%F).tar.gz -C /wa .
```

Keep `.env` somewhere safe too. It holds `SECRET_KEY`, and every connector token in the
database is encrypted with it: a dump restored without it reads as a workspace whose
mailboxes and bots have all quietly forgotten their credentials.
