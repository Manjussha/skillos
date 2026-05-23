import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/prisma/client.js";

/**
 * Runtime database access for SkillOS (Layer 2).
 *
 * Prisma 7 connects through a driver adapter rather than a datasource URL in
 * the schema. We use better-sqlite3 against storage/skillos.db. The path is
 * resolved relative to the repo root (the server runs from apps/server, mirror
 * of the SKILLS_DIR pattern in skills/engine.ts). Override with SKILLOS_DB_PATH.
 */
export function dbPath(): string {
  return (
    process.env.SKILLOS_DB_PATH ??
    resolve(process.cwd(), "../../storage/skillos.db")
  );
}

let client: PrismaClient | null = null;

/** Lazily create the singleton PrismaClient backed by better-sqlite3. */
export function getDb(): PrismaClient {
  if (client) return client;
  const adapter = new PrismaBetterSqlite3({ url: `file:${dbPath()}` });
  client = new PrismaClient({ adapter });
  return client;
}

/**
 * Verify the DB is reachable and the schema has been pushed. Throws a friendly
 * error pointing at `npm run db:push` if the tables are missing, so a fresh
 * clone fails loudly instead of mid-request.
 */
export async function ensureDb(): Promise<void> {
  const path = dbPath();
  if (!existsSync(path)) {
    throw new Error(
      `SQLite DB not found at ${path}. Run: npm run db:push -w apps/server`,
    );
  }
  try {
    await getDb().user.count();
  } catch (err) {
    throw new Error(
      `DB at ${path} is unusable (schema not applied?). ` +
        `Run: npm run db:push -w apps/server. Cause: ${(err as Error).message}`,
    );
  }
}

/** Close the connection (for clean shutdown / scripts). */
export async function closeDb(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}
