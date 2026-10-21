# Arlo Desktop

Customer service and sales, answered from what your company already knows, on your own
machine.

Point Arlo at your documents and your website. It answers customers on whatever channel
they turned up on, cites the passage each answer came from, and hands the conversation to a
person the moment it should. Everything it reads and everything it says is stored in a
Postgres container on your hardware: nothing is uploaded, and the only thing that leaves is
the question being asked of the model.

---

## Arlo Desktop and Arlo Cloud

Same answering engine. Desktop is the whole of it running locally for one business;
[Arlo Cloud](https://arlo.autobricks.ai) adds the things that only start to matter once a
team is running on it, and takes the operations off you.

| | Desktop | Cloud |
|---|---|---|
| **Knowledge** | | |
| Upload documents, crawl a website, type a note | ✓ | ✓ |
| Scanned PDFs, read with OCR | ✓ | ✓ |
| Keyword search, with no API key at all | ✓ | ✓ |
| Vector search, with an embeddings key | ✓ | ✓ |
| Find which passage a sentence came from, and which pages you corrected by hand | ✓ | ✓ |
| Graph RAG: reaches passages that share no words with the question | – | ✓ |
| **Channels** | | |
| Web widget | ✓ | ✓ |
| Telegram | ✓ | ✓ |
| WhatsApp | ✓ | ✓ |
| Gmail and Outlook | ✓ | ✓ |
| **Answering** | | |
| Cited answers, confidence floor, hand-off to a person | ✓ | ✓ |
| Tools: search the knowledge base, search the web, send a file, notify the team | ✓ | ✓ |
| Guardrails you write | ✓ | ✓ |
| Guardrails suggested from your knowledge base | – | ✓ |
| Modes: live, learning, paused | ✓ | ✓ |
| Playground: talk to a bot yourself, with no customer on the other end | ✓ | ✓ |
| Let it answer one conversation while it stays paused everywhere else | ✓ | ✓ |
| Draft mode: the bot writes, a person edits and sends | – | ✓ |
| **Teaching it** | | |
| Reads finished conversations and proposes what it learned, for you to approve | ✓ | ✓ |
| Correct an approved answer, and choose the files that go out with it | ✓ | ✓ |
| Files approved facts into a knowledge base of their own, and cites them | ✓ | ✓ |
| Learns customer details from what the customer said | ✓ | ✓ |
| Proposes dates, prices and files it saw, not only wording | ✓ | ✓ |
| **Inbox and contacts** | | |
| Every channel in one thread list | ✓ | ✓ |
| Take over, reply as yourself, hand back | ✓ | ✓ |
| Send a file with a reply, and see the pictures customers send | ✓ | ✓ |
| Contact cards, one person across every channel | ✓ | ✓ |
| Price list and business calendar the bot can quote | ✓ | ✓ |
| **Sales** | | |
| Projects: boards, stages, leads | – | ✓ |
| Lead qualification: infers which stage someone belongs in | – | ✓ |
| Deals, bookings, reminders | – | ✓ |
| **Running it** | | |
| One workspace | ✓ | ✓ |
| Several workspaces, with roles per workspace | – | ✓ |
| Analytics, SSO, audit log | – | ✓ |
| Your own Autobricks key | ✓ | ✓ |
| Arlo's shared model, billed to us | – | ✓ |
| Hosted: backups, and a WhatsApp session somebody else keeps alive | – | ✓ |
| Files kept out of the database, so Postgres stays a database | on disk | in object storage |
| Everything stored on your own machine, in a container you control | ✓ | – |

---

## Install

You need [Docker](https://docs.docker.com/get-docker/). Nothing else: no Node, no
Postgres, no `npm install`.

```bash
git clone <this repo> arlo-desktop
cd arlo-desktop

chmod +x scripts/setup.sh setup/docker-init.sh

./scripts/setup.sh          # macOS, Linux, Git Bash
docker compose up -d
```

On Windows without a shell, the same thing:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
docker compose up -d
```

Open **http://127.0.0.1:9005** and sign in with `arlo` / `arlo`.

It runs in the background and keeps running, including after a reboot. The three commands
that go with that:

```bash
docker compose logs -f app   # watch it, Ctrl-C stops watching, not the app
docker compose ps            # what is running
docker compose down          # stop it; your data stays
```

First boot builds the image, so give it a minute before the page answers. Drop the `-d` to
watch that happen in the terminal instead, then Ctrl-C does stop it.

`down` keeps everything. **`down -v` does not** -- it deletes the volumes, and your answers
live in two of them: the database, and the file store that uploads and sent files are moved
into so Postgres does not have to hold them. A file that has been moved has no second copy
in the database, by design, so `-v` is the one command here that loses work. It is in the
troubleshooting section below because a first boot that never came up has nothing to lose.

That is the whole install. `setup` writes a `.env` with four freshly generated secrets in
it (three database passwords and the key that encrypts everything else), so there is
nothing to paste and nothing to get subtly wrong. It never overwrites a `.env` you already
have, so it is safe to run twice.

First boot creates the database roles, the schema and pgvector; the first sign-in creates
your workspace, its website widget and somewhere to put knowledge.

<details>
<summary>Doing it by hand instead</summary>

The script is a convenience, not a dependency. `cp .env.example .env`, open it in any
editor, and fill in **four values**. There is nothing clever about them: they are secrets
because nobody else knows them, not because of how they were generated.

| Variable | What it is |
|---|---|
| `POSTGRES_SUPERUSER_PASSWORD` | The Postgres superuser, used once to create the roles |
| `ARLO_OWNER_PASSWORD` | Owns the schema, runs migrations |
| `ARLO_APP_PASSWORD` | What the app connects as, and cannot bypass row-level security |
| `SECRET_KEY` | Encrypts connector tokens and the model key at rest |

**Typing on the keyboard is a valid way to fill these in.** Mash out twenty-odd characters
per line and you are done:

```ini
POSTGRES_SUPERUSER_PASSWORD=kj3hf9wm2xqp8rtv6ybn
ARLO_OWNER_PASSWORD=8shdq2mfk4wpx7ncv3jt
ARLO_APP_PASSWORD=p2xn8kqw5jhf3mtb9rvc
SECRET_KEY=whatever you like here, it is hashed
```

Two rules, and only two:

- **The three database passwords must be letters and digits only.** `setup/docker-init.sh`
  substitutes them into `setup/00-roles.sql` with `sed`, so a `/`, a quote, a backslash or
  an `&` breaks it. It now refuses rather than mangling, but it is easier not to. Length is
  up to you; twenty characters is plenty.
- **`SECRET_KEY` can be literally any text.** It is put through SHA-256 to derive the actual
  key, so length and character set do not matter, only that it is hard to guess and that
  you do not change it later. Rotating it makes every stored token read as absent.

Prefer a generator? One of these per value:

```bash
head -c 21 /dev/urandom | od -An -tx1 | tr -d ' \n'
```

Two things worth knowing, because both have cost somebody an evening:

- **Each `CHANGE-ME-…` placeholder appears twice**: once on its own line for Docker, once
  inside `DATABASE_URL` for running outside it, and **both copies must match**. Replace
  all occurrences, not the first one.
- **Save the file with Unix (LF) line endings.** A `.env` with Windows line endings puts a
  carriage return on the end of every value, and the password Postgres stores then differs
  by one invisible character from the one the app sends. What you get is
  `password authentication failed for user "arlo_owner"` against a file that looks perfect.
  VS Code shows CRLF/LF in the status bar and switches on click; `.gitattributes` keeps a
  fresh checkout right, and `./scripts/setup.sh` fixes an existing file in place.

</details>

### Change the password immediately

`arlo` / `arlo` is published in this file, so everybody has it. The app says so on every
page until you change it, in **Settings → General**, where you can change the username too.

### Add a model

Arlo runs without one: every question just goes to a person, unanswered rather than
invented. To have it answer, paste an [Autobricks](https://autobricks.ai) API key into
**Settings → Model provider**. It is saved encrypted in the database and written back to
your `.env`, so it survives `docker compose down -v`.

Autobricks is the only provider this build talks to. Another one means editing
`src/server/llm.ts`: there is one endpoint constant and one model default, and that is the
whole of it.

### Semantic search, optionally

Without an embeddings key, retrieval uses Postgres full-text search: it finds passages that
share words with the question. That works, and the test suite runs on it.

For search by *meaning*, set both of these in `.env` and restart:

```ini
EMBEDDINGS_URL=https://api.autobricksai.com/v1/embeddings
EMBEDDINGS_KEY=<your Autobricks key>
EMBEDDINGS_MODEL=autobricksai/text-embedding-3-small
```

The model must return **1536-wide** vectors, because that is the `vector(1536)` column in
`migrations/001_schema.sql`. `text-embedding-3-small` is that natively; `text-embedding-3-large`
and `gemini-embedding-001` are 3072 but accept a `dimensions` parameter, so set
`EMBEDDINGS_DIMS=1536` if you use one. Anything already stored is embedded in the background
once a key appears.

This is the one call configured per install rather than per workspace, which is also the one
place another provider can be pointed at: see `src/server/embed.ts` for why.

---

## When the first boot does not work

Almost everything that goes wrong here goes wrong once, on the first `docker compose up -d`,
and says so somewhere you were not looking.

**`dependency failed to start: container …-db-1 is unhealthy`**

The database container is what failed, so its logs are the ones that say why, and the app's
logs, which is where people look, are empty by definition:

```bash
docker compose logs db
```

The database only runs `setup/docker-init.sh` on the **first boot of an empty volume**. That
means two things worth knowing together: a failure there leaves a half-initialised volume
that will not fix itself on restart, and the fix is always to throw the volume away and try
again, not to restart:

```bash
docker compose down -v      # deletes the database: fine here, it never came up
docker compose up -d
```

Look for one of these in `docker compose logs db`:

| In the log | What happened |
|---|---|
| `A database password contains one of / \ ' " &` | Exactly what it says. Those are substituted into SQL and cannot be escaped safely. Use letters and digits. |
| `sourcing /docker-entrypoint-initdb.d/00-arlo-roles.sh` | The script lost its executable bit: see below. It should say **running**, not sourcing. |
| `password authentication failed` | Line endings, usually. Run `./scripts/setup.sh` again; it repairs a `.env` in place. |

**`zsh: permission denied: ./scripts/setup.sh`**

The executable bit did not survive however the files got to you: copying a folder between
machines drops it, and so does unzipping on some systems. `git clone` preserves it.

```bash
chmod +x scripts/setup.sh setup/docker-init.sh
```

Do both. `setup/docker-init.sh` matters more than the one you noticed: Postgres *sources* an
init script it cannot execute instead of running it, which lets that script's `set -eu`
escape into the entrypoint's own shell and take the rest of initialisation down with it. The
symptom is the unhealthy container above, several steps removed from the cause.

**Compose says a variable `is missing a value`**

`.env` is not filled in. `./scripts/setup.sh` does it and now refuses to finish while any of
the four is still blank; "Doing it by hand" in the install section above is the manual
version.

---

## Connecting a channel

**Connectors** is where a customer gets a way in.

| Channel | What it needs |
|---|---|
| **Web chat** | Nothing. Name a site, copy the `<script>` tag, paste it into your page |
| **Telegram** | A bot token from [@BotFather](https://t.me/botfather), and a `PUBLIC_URL` Telegram can reach |
| **WhatsApp** | A phone to scan a QR code |
| **Gmail / Outlook** | An OAuth app of your own: `GOOGLE_CLIENT_ID` / `OUTLOOK_CLIENT_ID` and their secrets in `.env` |

The web widget is the one that works with no third-party account, so it is the one to try
first. Allow lists start **empty** on Telegram and WhatsApp: a linked number answers nobody
until you pick who it may talk to. WhatsApp's is per *chat*, because that socket can see the
owner's private conversations.

`PUBLIC_URL` must be the address a browser actually types. The widget snippet, Telegram
webhook addresses and OAuth redirects are all built from it.

---

## Degrading, on purpose

Nothing here requires an API key to work:

| Missing | What happens |
|---|---|
| `EMBEDDINGS_URL` / `EMBEDDINGS_KEY` | retrieval falls back to Postgres full-text search |
| An Autobricks key | questions go straight to a person, unanswered rather than invented |
| both | the product still runs, and the whole test suite exercises this path |

---

## Running it somewhere other than your own machine

Compose is the supported way to run this and the image is what it runs, so putting it on a
VPS or a NAS is the same two commands: what changes is everything in front of it. The port
publishes to `127.0.0.1` deliberately, and there is one account and one password, so a
reverse proxy there is not only for TLS.

[docs/DEPLOY.md](docs/DEPLOY.md) covers that: the proxy, the headers it has to pass,
`PUBLIC_URL`, and what to back up.

---

## License

Arlo Desktop is **fair-code**, not open source: the [Sustainable Use
License](LICENSE.md).

The short version: **run it for your own business, free, with no user limit.** Read it,
change it, build on it, pass it on. What you may not do is sell it or host it as a service
for other people, that is what [Arlo Cloud](https://arlo.autobricks.ai) is, and it is what
pays for this.

If you want to offer Arlo to your own customers, that needs a commercial licence:
**team@autobricks.ai**.

Copyright © 2026 Autobricks AI Pte Ltd.
