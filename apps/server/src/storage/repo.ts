import { randomBytes } from "node:crypto";
import { getDb } from "./db.js";
import type { Profile, User } from "../generated/prisma/client.js";

/**
 * Thin data-access helpers over Prisma. Keeps SQL/ORM concerns out of the
 * gateway and the onboarding flow. v0.1 is local single-user, so we resolve a
 * single "local" user; the schema already supports multi-user for Layer 4.
 */

const LOCAL_EMAIL = "local@skillos";

/** Get (or create) the single local user for this install. */
export async function getLocalUser(): Promise<User> {
  const db = getDb();
  const existing = await db.user.findUnique({ where: { email: LOCAL_EMAIL } });
  if (existing) return existing;
  return db.user.create({ data: { email: LOCAL_EMAIL } });
}

/** The user's onboarding profile, or null if they haven't onboarded. */
export async function getProfile(userId: string): Promise<Profile | null> {
  return getDb().profile.findUnique({ where: { userId } });
}

export interface ProfileInput {
  userType: string;
  useCase: string;
  stacks: string[];
  mode: string;
  activeSkills: string[];
}

/** Create or replace the user's profile (idempotent upsert). */
export async function saveProfile(
  userId: string,
  input: ProfileInput,
): Promise<Profile> {
  const db = getDb();
  const data = {
    userType: input.userType,
    useCase: input.useCase,
    stacks: JSON.stringify(input.stacks),
    mode: input.mode,
    activeSkills: JSON.stringify(input.activeSkills),
  };
  return db.profile.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
}

/** Parse a JSON-encoded string[] column safely. */
export function parseStringList(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Create a session row with a random token (scoped permissions for Layer 4).
 *
 * `expiresAt` is optional: local connection sessions (used only to namespace
 * message history) are created without one, while Layer 4 remote-access tokens
 * are minted with a hard expiry so a leaked URL stops working.
 */
export async function createSession(
  userId: string,
  permissions: string[] = [],
  expiresAt: Date | null = null,
): Promise<{ id: string; token: string; permissions: string[]; expiresAt: Date | null }> {
  const token = randomBytes(24).toString("hex");
  const session = await getDb().session.create({
    data: {
      userId,
      token,
      permissions: JSON.stringify(permissions),
      expiresAt,
    },
  });
  return {
    id: session.id,
    token: session.token,
    permissions,
    expiresAt: session.expiresAt,
  };
}

/**
 * Look up a session by its token. Returns null when the token is unknown.
 * Callers must additionally check `expiresAt` (see `validateToken`).
 */
export async function findSessionByToken(token: string): Promise<{
  id: string;
  userId: string;
  permissions: string[];
  expiresAt: Date | null;
} | null> {
  const row = await getDb().session.findUnique({ where: { token } });
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    permissions: parseStringList(row.permissions),
    expiresAt: row.expiresAt,
  };
}

/**
 * Validate a remote token: it must exist and not be expired. Returns the
 * session (with parsed scoped permissions) on success, or a reason on failure.
 * This is the single chokepoint for remote authentication.
 */
export async function validateToken(
  token: string,
  now: Date = new Date(),
): Promise<
  | { ok: true; session: { id: string; userId: string; permissions: string[]; expiresAt: Date | null } }
  | { ok: false; reason: "unknown" | "expired" }
> {
  if (!token) return { ok: false, reason: "unknown" };
  const session = await findSessionByToken(token);
  if (!session) return { ok: false, reason: "unknown" };
  if (session.expiresAt && session.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, session };
}

/** Revoke a single token (delete its session row). No-op if unknown. */
export async function revokeSession(token: string): Promise<void> {
  await getDb()
    .session.deleteMany({ where: { token } })
    .catch(() => {});
}

export interface MessageInput {
  userId: string;
  sessionId?: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  model?: string | null;
  skill?: string | null;
}

/** Persist one conversation turn. */
export async function saveMessage(input: MessageInput): Promise<void> {
  await getDb().message.create({
    data: {
      userId: input.userId,
      sessionId: input.sessionId ?? null,
      role: input.role,
      content: input.content,
      model: input.model ?? null,
      skill: input.skill ?? null,
    },
  });
}

/** Recent conversation history, newest last. */
export async function recentMessages(userId: string, take = 20) {
  const rows = await getDb().message.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take,
  });
  return rows.reverse();
}

/** Record/refresh metadata for a skill on disk (provenance tracking). */
export async function upsertSkillMeta(meta: {
  name: string;
  category: string;
  description: string;
  bestModel: string;
  origin: "builtin" | "generated" | "installed";
  source: string;
}): Promise<void> {
  await getDb().skill.upsert({
    where: { name: meta.name },
    create: meta,
    update: {
      category: meta.category,
      description: meta.description,
      bestModel: meta.bestModel,
      origin: meta.origin,
      source: meta.source,
    },
  });
}
