import { createHash, randomBytes } from "node:crypto";

// 256-bit random secret (the prompt asks for at least 128). Only the hash is ever stored.
export const newToken = (): string => randomBytes(32).toString("base64url");
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
