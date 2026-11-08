/**
 * Parse `api-id=Menu` or `api-id=Menu|Detail` pairs. The API id is unchanged; Detail is
 * optional identification text (billing / hint), not a third menu choice.
 */
export function parseModelLabelPairs(
  raw: string | undefined,
  knownIds: ReadonlySet<string>,
): ReadonlyMap<string, { label: string; detail?: string }> {
  const labels = new Map<string, { label: string; detail?: string }>();
  for (const part of (raw ?? "").split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const id = trimmed.slice(0, eq).trim();
    const rest = trimmed.slice(eq + 1).trim();
    if (!id || !rest || !knownIds.has(id)) continue;
    const bar = rest.indexOf("|");
    if (bar < 0) {
      labels.set(id, { label: rest });
      continue;
    }
    const label = rest.slice(0, bar).trim();
    const detail = rest.slice(bar + 1).trim();
    if (!label) continue;
    labels.set(id, detail ? { label, detail } : { label });
  }
  return labels;
}
