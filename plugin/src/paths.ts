/** Pure helpers — no Obsidian imports so they stay unit-testable. */

export interface FileMeta {
  guid: string;
  /** Docs: cyrb53 of the text. Blobs: SHA-256 hex of the bytes (R2 key). */
  hash: string;
  mtime: number;
  /** Absent means "doc" (markdown CRDT); "blob" is a content-addressed binary. */
  kind?: "doc" | "blob";
}

/** SHA-256 hex — content address for attachment blobs. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** HMAC-SHA-256 hex — publish-link capability signatures (mirrors the server). */
export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function base64UrlEncode(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** cyrb53 — cheap 53-bit content hash for change detection, not crypto. */
export function contentHash(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Is `path` strictly inside the folder at `folderPath`? */
export function isUnder(folderPath: string, path: string): boolean {
  return path.startsWith(`${folderPath}/`);
}

export function toRelative(folderPath: string, path: string): string {
  return path.slice(folderPath.length + 1);
}

export function joinPath(folderPath: string, rel: string): string {
  return `${folderPath}/${rel}`;
}

export interface MapDelta {
  added: Array<{ path: string; meta: FileMeta }>;
  removed: Array<{ path: string; meta: FileMeta }>;
  updated: Array<{ path: string; meta: FileMeta }>;
  renamed: Array<{ from: string; to: string; meta: FileMeta }>;
}

/**
 * Classify a Y.Map change set. A rename arrives as a delete plus an add with
 * the same guid inside one transaction; pair those up so the reconciler can
 * rename on disk instead of trashing and re-creating.
 */
export function classifyMapDelta(
  changes: Map<string, { action: "add" | "update" | "delete"; oldValue: unknown }>,
  getCurrent: (key: string) => FileMeta | undefined,
): MapDelta {
  const added: MapDelta["added"] = [];
  const removed: MapDelta["removed"] = [];
  const updated: MapDelta["updated"] = [];
  for (const [key, change] of changes) {
    if (change.action === "add") {
      const meta = getCurrent(key);
      if (meta) added.push({ path: key, meta });
    } else if (change.action === "delete") {
      removed.push({ path: key, meta: change.oldValue as FileMeta });
    } else {
      const meta = getCurrent(key);
      if (meta) updated.push({ path: key, meta });
    }
  }
  const renamed: MapDelta["renamed"] = [];
  for (const del of [...removed]) {
    const add = added.find((a) => a.meta.guid === del.meta.guid);
    if (!add) continue;
    renamed.push({ from: del.path, to: add.path, meta: add.meta });
    removed.splice(removed.indexOf(del), 1);
    added.splice(added.indexOf(add), 1);
  }
  return { added, removed, updated, renamed };
}
