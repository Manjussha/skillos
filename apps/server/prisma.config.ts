import { defineConfig } from "@prisma/config";
import { resolve } from "node:path";

/**
 * Prisma 7 config. The CLI (`prisma db push`, `prisma generate`) reads the
 * schema location and — for migration commands — the datasource URL from here
 * rather than from schema.prisma. The runtime PrismaClient uses a driver
 * adapter instead (see src/storage/db.ts), so this URL is only used by the CLI.
 *
 * The DB lives at <repo-root>/storage/skillos.db. We use a relative `file:`
 * URL resolved from the CLI's cwd (apps/server), so "../../storage/skillos.db"
 * lands in storage/. A relative URL avoids the percent-encoded-path bug the
 * schema engine hits with absolute file:// URLs on paths containing spaces
 * (Windows). Override the whole URL with DATABASE_URL if you need it elsewhere.
 */
const repoRoot = resolve(import.meta.dirname, "..", "..");
const dbUrl = process.env.DATABASE_URL ?? "file:../../storage/skillos.db";

export default defineConfig({
  schema: resolve(repoRoot, "storage", "schema.prisma"),
  datasource: {
    url: dbUrl,
  },
});
