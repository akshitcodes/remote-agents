// What the *installed* provider CLI actually accepts.
//
// Provider CLIs gain, rename and retire flags between releases, and the set on
// this machine is not the set on anyone else's. Passing a flag the local build
// has never heard of does not degrade — the CLI refuses to start, so the send
// fails outright:
//
//   error: unknown option '--effort'
//   error: option '--permission-mode <mode>' argument 'auto' is invalid.
//           Allowed choices are acceptEdits, bypassPermissions, default, ...
//
// Both of those were reported from a real install, in that order. So the flags
// are read from the binary's own `--help` rather than assumed, and anything it
// does not advertise is dropped or mapped to the nearest thing it does.

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";

const HELP_TIMEOUT_MS = 10000;

// Long flags, e.g. --permission-mode. Short flags are never gated: they are the
// stable part of these CLIs, and a false negative would drop a working flag.
const FLAG = /--[a-z][a-z0-9]*(?:-[a-z0-9]+)*/g;

// commander: (choices: "a", "b")   clap: [possible values: a, b]
const CHOICES = /choices:\s*((?:"[^"]*"\s*,?\s*)+)|\[possible values:\s*([^\]]+)\]/g;

export function parseCliHelp(text) {
  const help = String(text ?? "");
  const flags = new Set(help.match(FLAG) ?? []);
  const choices = new Map();

  // Associate each choice list with the nearest flag mentioned before it, which
  // is how both help formats lay them out.
  for (const match of help.matchAll(CHOICES)) {
    const preceding = [...help.slice(0, match.index).matchAll(FLAG)].pop()?.[0];
    if (!preceding) { continue; }

    const values = match[1]
      ? [...match[1].matchAll(/"([^"]*)"/g)].map((m) => m[1])
      : match[2].split(",").map((value) => value.trim());

    const known = choices.get(preceding) ?? new Set();
    for (const value of values.filter(Boolean)) { known.add(value); }
    choices.set(preceding, known);
  }

  return { flags, choices, readable: flags.size > 0 };
}

// Unreadable help must not read as "supports nothing": that would silently strip
// working flags. Callers check `readable` and keep their previous behaviour.
export const UNKNOWN_CAPABILITIES = { flags: new Set(), choices: new Map(), readable: false };

const cache = new Map();

function cacheKey(bin) {
  try {
    const stat = statSync(bin);
    // An upgrade rewrites the binary, so mtime+size invalidates a stale answer
    // without needing to run the CLI again on every send.
    return `${bin}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return bin;
  }
}

export function capabilitiesFor(bin, { args = ["--help"], timeoutMs = HELP_TIMEOUT_MS, label = bin } = {}) {
  if (!bin) { return UNKNOWN_CAPABILITIES; }

  const key = cacheKey(bin);
  const cached = cache.get(key);
  if (cached) { return cached; }

  const result = spawnSync(bin, args, { encoding: "utf8", timeout: timeoutMs });
  // Some CLIs print help to stderr, and some exit non-zero doing it.
  const parsed = parseCliHelp(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);

  if (!parsed.readable) {
    console.error(`[${label}] could not read \`${args.join(" ")}\`; sending the flags this bridge was written against`);
  }

  cache.set(key, parsed);
  return parsed;
}

export function clearCapabilityCache() {
  cache.clear();
}

export function supportsFlag(caps, flag) {
  // Unknown means "carry on as before", not "unsupported".
  return caps.readable ? caps.flags.has(flag) : true;
}

// The first preference the CLI actually accepts. A CLI that advertises no
// choices for the flag is taken at its word for the first preference, since
// older builds document some values only in prose.
export function pickChoice(caps, flag, preferences) {
  // Unreadable help means "carry on as before" here too, matching supportsFlag:
  // dropping the flag on a CLI we simply could not interrogate would change
  // behaviour on machines where nothing is actually wrong.
  if (!caps.readable) { return preferences[0] ?? null; }
  if (!caps.flags.has(flag)) { return null; }

  const allowed = caps.choices.get(flag);
  if (!allowed?.size) { return preferences[0] ?? null; }

  return preferences.find((value) => allowed.has(value)) ?? null;
}
