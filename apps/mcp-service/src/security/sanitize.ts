// Normalizes an archive/manifest path. Returns null for anything that could escape the site root.
export function normalizePath(p: string): string | null {
  const s = p.replace(/\\/g, "/");
  if (s.includes("\0") || s.startsWith("/") || /^[a-zA-Z]:/.test(s)) return null;
  const parts = s.split("/").filter((x) => x !== "" && x !== ".");
  if (parts.includes("..") || parts.length === 0) return null;
  return parts.join("/");
}

// Paths derived from the project (e.g. the build folder) are echoed to the AI, so only allow a
// conservative charset. Anything else becomes null instead of leaking arbitrary text.
export function safeEchoPath(p: string): string | null {
  return /^[A-Za-z0-9._/-]{1,100}$/.test(p) && !p.includes("..") ? p : null;
}
