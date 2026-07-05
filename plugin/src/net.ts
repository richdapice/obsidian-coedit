import { requestUrl } from "obsidian";
import type { RelayCloneSettings } from "./settings";

/** Mirrors YProvider's scheme heuristic: plaintext for localhost/LAN only. */
function isLocalHost(host: string): boolean {
  const second = Number(host.split(".")[1]);
  return (
    host.startsWith("localhost:") ||
    host === "localhost" ||
    host.startsWith("127.") ||
    host.startsWith("192.168.") ||
    host.startsWith("10.") ||
    (host.startsWith("172.") && second >= 16 && second <= 31)
  );
}

function docUrl(settings: RelayCloneSettings, room: string): string {
  const scheme = isLocalHost(settings.serverHost) ? "http" : "https";
  return `${scheme}://${settings.serverHost}/parties/y-doc-server/${encodeURIComponent(room)}/as-update?token=${encodeURIComponent(settings.token)}`;
}

export function roomName(folderId: string, docId: string): string {
  return `${folderId}:${docId}`;
}

/** GET the server's current doc state as a Yjs update. requestUrl bypasses CORS. */
export async function pullDocState(settings: RelayCloneSettings, room: string): Promise<Uint8Array> {
  const res = await requestUrl({ url: docUrl(settings, room), throw: false });
  if (res.status !== 200) throw new Error(`pull ${room}: HTTP ${res.status}`);
  return new Uint8Array(res.arrayBuffer);
}

/** POST a Yjs update; the server applies it, broadcasts, and persists. */
export async function pushDocState(
  settings: RelayCloneSettings,
  room: string,
  update: Uint8Array,
): Promise<void> {
  const res = await requestUrl({
    url: docUrl(settings, room),
    method: "POST",
    body: update.buffer.slice(update.byteOffset, update.byteOffset + update.byteLength) as ArrayBuffer,
    throw: false,
  });
  if (res.status !== 204) throw new Error(`push ${room}: HTTP ${res.status}`);
}
