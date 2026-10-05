export const DOOR_PREFIX = "🚪";
const VIEW_CHANNEL = 1n << 10n;

export function extractCode(name) {
  if (typeof name !== "string") return null;
  const m = /(\d+)\s*$/.exec(name);
  return m ? m[1] : null;
}

function overwriteGrantsView(o, userId) {
  const isMember = o.type === 1 || o.type === "member";
  if (!isMember || o.id !== userId) return false;
  let allow;
  try {
    allow = BigInt(o.allow ?? "0");
  } catch {
    return false;
  }
  return (allow & VIEW_CHANNEL) !== 0n;
}

export function findUserChannel(channels, userId) {
  const matches = channels.filter(
    (c) =>
      typeof c.name === "string" &&
      c.name.startsWith(DOOR_PREFIX) &&
      (c.permission_overwrites ?? []).some((o) => overwriteGrantsView(o, userId)),
  );
  if (matches.length === 0) return { error: "none" };
  if (matches.length > 1) return { error: "multiple" };
  return { channel: matches[0] };
}
