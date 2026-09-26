import { createConnection } from "node:net";

// Antivirus: every file that survived the signature scan goes through ClamAV (the clamd daemon, INSTREAM protocol over TCP).
// The service never runs the files and never writes them to disk: the bytes are streamed to clamd and only the verdict comes back.

export interface AvVerdict {
  /** false when clamd could not be reached or answered with an error for some file: those files are NOT vouched for */
  complete: boolean;
  infected: { path: string; signature: string }[];
}
export type AvScanner = (files: Map<string, Uint8Array>) => Promise<AvVerdict>;

export interface ClamdOptions {
  host: string;
  port: number;
  /** per file */
  timeoutMs?: number;
  concurrency?: number;
}

type One = { status: "clean" } | { status: "infected"; signature: string } | { status: "error" };

const CHUNK = 64 * 1024;

/** One file through clamd. Never throws: an unreachable daemon is { status: "error" }. */
export function scanStream(o: ClamdOptions, bytes: Uint8Array): Promise<One> {
  return new Promise((resolve) => {
    let reply = "";
    let done = false;
    const finish = (r: One) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(r);
    };
    const socket = createConnection({ host: o.host, port: o.port });
    socket.setTimeout(o.timeoutMs ?? 30_000, () => finish({ status: "error" }));
    socket.on("error", () => finish({ status: "error" }));
    socket.on("data", (d) => (reply += d.toString("latin1")));
    socket.on("close", () => {
      // "stream: OK" | "stream: <signature> FOUND" | "... ERROR" (e.g. size limit exceeded)
      const r = reply.replace(/\0/g, "").trim();
      if (/^stream: OK$/.test(r)) return finish({ status: "clean" });
      const found = /^stream: (.+) FOUND$/.exec(r);
      finish(found ? { status: "infected", signature: found[1]!.slice(0, 120) } : { status: "error" });
    });
    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      for (let i = 0; i < bytes.length; i += CHUNK) {
        const part = bytes.subarray(i, i + CHUNK);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(part.length);
        socket.write(len);
        socket.write(part);
      }
      socket.write(Buffer.alloc(4)); // zero-length chunk: end of stream
    });
  });
}

/** A scanner that streams every file to clamd, a few at a time. */
export function clamdScanner(o: ClamdOptions): AvScanner {
  return async (files) => {
    const queue = [...files];
    const verdict: AvVerdict = { complete: true, infected: [] };
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [path, bytes] = next;
        const r = await scanStream(o, bytes);
        if (r.status === "infected") verdict.infected.push({ path, signature: r.signature });
        else if (r.status === "error") verdict.complete = false;
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 4) }, worker));
    return verdict;
  };
}
