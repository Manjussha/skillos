# storage/ — Layer 2 (persistence)

SQLite + Prisma. This directory holds the Prisma schema and the SQLite database
file; runtime data-access lives in `apps/server/src/storage/`.

## What's here

- `schema.prisma` — the data model (see below).
- `skillos.db` — the SQLite database (gitignored; created by `db:push`).

The Prisma **client** is generated into `apps/server/src/generated/prisma/`
(gitignored) and the CLI config lives in `apps/server/prisma.config.ts`.

## Models

| Model | Purpose |
| --- | --- |
| `User` | One local user in v0.1 (`local@skillos`); multi-user-ready for Layer 4. |
| `Profile` | Onboarding answers: `userType`, `useCase`, `stacks[]`, `mode`, `activeSkills[]`. |
| `Skill` | Provenance metadata for skills on disk (`builtin` / `generated` / `installed`). |
| `SkillPack` | Installed skill packs (bundle of skill names). |
| `Session` | Connection/auth session: `token`, `permissions[]`, `expiresAt` (tokens become load-bearing in Layer 4). |
| `RoutingPreference` | User-pinned `selector → model` routing overrides. |
| `Message` | Conversation history: `role`, `content`, `model`, `skill`, `createdAt`. |

> Note: SQLite has no array/JSON column type here, so `string[]` fields
> (`stacks`, `permissions`, `activeSkills`, pack `skills`) are stored as
> JSON-encoded strings. Use `parseStringList()` in `repo.ts` to read them.

## Prisma 7 specifics

Prisma 7 no longer puts the datasource URL in `schema.prisma`. Instead:

- The **CLI** (`generate`, `db push`, `studio`) reads the schema path and the
  datasource URL from `apps/server/prisma.config.ts`. The default URL is the
  relative `file:../../storage/skillos.db` (resolved from the `apps/server` cwd
  where the CLI runs), so the DB lands here in `storage/`.
- The **runtime** `PrismaClient` connects through the `better-sqlite3` driver
  adapter (`apps/server/src/storage/db.ts`), pointed at the same file resolved
  to an absolute path from the repo root. Override with `SKILLOS_DB_PATH`.

## Commands

Run from the repo root (they target the server workspace):

```bash
npm run db:generate -w apps/server   # regenerate the Prisma client
npm run db:push     -w apps/server   # create/sync storage/skillos.db from the schema
npm run db:studio   -w apps/server   # open Prisma Studio (optional)
```

A fresh clone must run `db:generate` (the generated client is gitignored) and
`db:push` (the DB is gitignored) before starting the server. The server calls
`ensureDb()` on boot and fails fast with the `db:push` hint if the DB/tables are
missing.

This dev schema uses `db push` (no migration history yet). To switch to
migrations later: `npx prisma migrate dev` with the same config.
