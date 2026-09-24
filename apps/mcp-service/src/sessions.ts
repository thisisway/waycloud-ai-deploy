import type { Db } from "./db/index.js";
import { hashToken, newToken } from "./security/tokens.js";

export const SESSION_TTL_HOURS = 72;

export interface Session {
  id: string;
  expires_at: Date;
}

export async function createSession(db: Db, opts: { ttlHours?: number; ipHash?: string; userAgent?: string } = {}) {
  const token = newToken();
  const [row] = await db.query<{ expires_at: Date }>(
    "INSERT INTO sessions (token_hash, ip_hash, user_agent, expires_at) VALUES ($1, $2, $3, now() + make_interval(hours => $4)) RETURNING expires_at",
    [hashToken(token), opts.ipHash ?? null, opts.userAgent ?? null, opts.ttlHours ?? SESSION_TTL_HOURS],
  );
  return { token, expiresAt: row!.expires_at };
}

export async function findSession(db: Db, token: string): Promise<Session | null> {
  const [row] = await db.query<Session>("SELECT id, expires_at FROM sessions WHERE token_hash = $1 AND state = 'active' AND expires_at > now()", [hashToken(token)]);
  return row ?? null;
}
