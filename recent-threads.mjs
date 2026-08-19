const DEFAULT_LIMIT = 10;

// The dashboard is intentionally task-first: active work always wins, then
// everything idle is ordered by the provider's last-updated timestamp. Keep
// this pure so the ordering contract can be tested without starting the bridge.
export function rankRecentThreads(groups, { limit = DEFAULT_LIMIT } = {}) {
  const rows = (groups ?? []).flatMap((group) => Array.isArray(group) ? group : []);

  return sortRecentThreads(rows)
    .slice(0, Math.max(0, Number(limit) || DEFAULT_LIMIT));
}

export function sortRecentThreads(rows, { runningFirst = true } = {}) {
  return [...(rows ?? [])]
    .sort((a, b) => {
      if (runningFirst) {
      const running = Number(!!b?.running) - Number(!!a?.running);

      if (running) { return running; }
      }

      const updated = Number(b?.updatedAt ?? 0) - Number(a?.updatedAt ?? 0);

      if (updated) { return updated; }

      return `${a?.provider ?? ""}:${a?.id ?? ""}`.localeCompare(`${b?.provider ?? ""}:${b?.id ?? ""}`);
    });
}
