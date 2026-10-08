const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_MS = 86400_000;

function cachedLabel(fetchedAt, now) {
  const t = Number(fetchedAt);
  if (!fetchedAt || !Number.isFinite(t)) return "cached";
  const then = new Date(t);
  const today = new Date(now);
  const sameDay =
    then.getFullYear() === today.getFullYear() &&
    then.getMonth() === today.getMonth() &&
    then.getDate() === today.getDate();
  if (sameDay) return "cached, from today";
  if (now - t > 7 * DAY_MS) return "cached, over a week old";
  return `cached, from ${DAYS[then.getDay()]}`;
}

export function statusLine(view, fetchedAt, now) {
  switch (view.kind) {
    case "notoken":
      return "Set up in phone app settings";
    case "loading":
      return fetchedAt ? cachedLabel(fetchedAt, now) : "loading...";
    case "ok":
      return "just now";
    case "reauth":
      return "Sign in again in settings";
    case "unparseable":
      return "Code unreadable";
    case "stale":
    default:
      return fetchedAt ? cachedLabel(fetchedAt, now) : "Phone not reachable. Reopen app.";
  }
}

export function bigText(view, cachedCode) {
  if (view.kind === "ok") return view.code;
  if (view.kind === "notoken" || view.kind === "reauth") return "----";
  return cachedCode || "----";
}
