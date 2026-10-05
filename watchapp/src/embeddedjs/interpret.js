export function interpret(result) {
  if (!result || result.error) return { kind: "stale" };
  const { status, body } = result;
  if (status === 200) {
    const code = body && typeof body.code === "string" ? body.code : "";
    return code ? { kind: "ok", code } : { kind: "stale" };
  }
  if (status === 401 || status === 403) return { kind: "reauth" };
  if (status === 422) return { kind: "unparseable" };
  return { kind: "stale" };
}
