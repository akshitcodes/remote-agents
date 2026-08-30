import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function canonicalLimit(value) {
  if (!value || typeof value !== "object") { return value ?? null; }
  const used = typeof value.usedPercent === "number" ? value.usedPercent : NaN;
  const remaining = typeof value.remainingPercent === "number" ? value.remainingPercent : NaN;
  const usedPercent = Number.isFinite(used) ? Math.max(0, Math.min(100, used)) : null;
  const remainingPercent = Number.isFinite(remaining)
    ? Math.max(0, Math.min(100, remaining))
    : usedPercent == null ? null : 100 - usedPercent;

  return {
    ...value,
    ...(usedPercent == null ? {} : { usedPercent }),
    ...(remainingPercent == null ? {} : { remainingPercent }),
  };
}

function canonicalRateLimits(value) {
  if (!value || typeof value !== "object") { return null; }
  if (value.rateLimits && typeof value.rateLimits === "object") {
    return {
      ...value,
      rateLimits: {
        ...value.rateLimits,
        primary: canonicalLimit(value.rateLimits.primary),
        secondary: canonicalLimit(value.rateLimits.secondary),
      },
    };
  }

  if (value.primary || value.secondary) {
    const { primary = null, secondary = null, rateLimitResetCredits, credits, ...rest } = value;
    return {
      ...rest,
      rateLimits: { primary: canonicalLimit(primary), secondary: canonicalLimit(secondary) },
      rateLimitResetCredits: rateLimitResetCredits ?? credits ?? null,
    };
  }

  return null;
}

function hasValue(value) {
  return value != null && (typeof value !== "object" || Object.keys(value).length > 0);
}

function accountIdentity(value) {
  return value?.accountId || value?.email || value?.accountLabel || null;
}

function hasMeasuredLimit(value) {
  const limits = value?.rateLimits;
  return [limits?.primary, limits?.secondary].some((limit) => Number.isFinite(limit?.usedPercent));
}

function mergeRateLimits(previous, incoming) {
  if (!previous) { return structuredClone(incoming); }
  if (!incoming) { return structuredClone(previous); }

  const previousLimits = previous.rateLimits ?? {};
  const incomingLimits = incoming.rateLimits ?? {};
  return {
    ...previous,
    ...incoming,
    rateLimits: {
      primary: incomingLimits.primary ? { ...previousLimits.primary, ...incomingLimits.primary } : previousLimits.primary ?? null,
      secondary: incomingLimits.secondary ? { ...previousLimits.secondary, ...incomingLimits.secondary } : previousLimits.secondary ?? null,
    },
  };
}

export class UsageStateStore {
  constructor({ file, now = () => Date.now() } = {}) {
    if (!file) { throw new Error("usage state file required"); }
    this.file = file;
    this.now = now;
    this.state = {};

    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) { this.state = parsed; }
    } catch {}
  }

  persist() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  invalidate(provider) {
    if (!Object.hasOwn(this.state, provider)) { return false; }
    delete this.state[provider];
    this.persist();
    return true;
  }

  merge(provider, snapshot = {}) {
    const at = this.now();
    const previous = this.state[provider] ?? { values: {}, observedAt: {} };
    const values = { ...previous.values };
    const observedAt = { ...previous.observedAt };
    const sources = {};
    const incoming = {
      account: snapshot.account ?? null,
      rateLimits: canonicalRateLimits(snapshot.rateLimits),
      usage: snapshot.usage ?? null,
    };
    let changed = false;

    const previousIdentity = accountIdentity(values.account);
    const incomingIdentity = accountIdentity(incoming.account);
    if (previousIdentity && incomingIdentity && previousIdentity !== incomingIdentity) {
      values.rateLimits = null;
      values.usage = null;
      delete observedAt.rateLimits;
      delete observedAt.usage;
    }

    for (const field of ["account", "rateLimits", "usage"]) {
      if (hasValue(incoming[field])) {
        if (field === "rateLimits" && hasValue(values.rateLimits) && !hasMeasuredLimit(incoming.rateLimits)) {
          sources[field] = "last-known";
          continue;
        }
        values[field] = field === "rateLimits" ? mergeRateLimits(values.rateLimits, incoming.rateLimits) : structuredClone(incoming[field]);
        observedAt[field] = at;
        sources[field] = "live";
        changed = true;
      } else if (hasValue(values[field])) {
        sources[field] = "last-known";
      } else {
        values[field] = null;
        sources[field] = "unavailable";
      }
    }

    if (changed) {
      this.state[provider] = { values, observedAt };
      this.persist();
    }

    return {
      account: values.account,
      rateLimits: values.rateLimits,
      usage: values.usage,
      _meta: {
        provider,
        checkedAt: at,
        sources,
        observedAt,
      },
    };
  }
}

export { canonicalRateLimits };
