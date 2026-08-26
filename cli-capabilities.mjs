// What the *installed* provider CLI actually accepts.
//
// Provider CLIs gain, rename and retire flags between releases, and the set on
// this machine is not the set on anyone else's. Unknown flag names and some
// enumerated values fail outright, while model/effort values may be silently
// ignored by the provider. We therefore discover names and enumerated values
// independently and require exact values at the dispatch boundary:
//
//   error: unknown option '--effort'
//   error: option '--permission-mode <mode>' argument 'auto' is invalid.
//           Allowed choices are acceptEdits, bypassPermissions, default, ...
//
// Both of those were reported from a real install, in that order. So the flags
// are read from the binary's own `--help` rather than assumed. Explicit values
// that cannot be proven are rejected; only an explicit provider-default choice
// is allowed to omit a setting.

import { execFile } from "node:child_process";
import { statSync } from "node:fs";

const HELP_TIMEOUT_MS = 3000;

// A real option row starts with an optional short flag followed by a long flag.
// Do not collect `--foo` tokens from prose: Claude's descriptions mention other
// flags, and treating those as option rows misattributes the following choices.
const OPTION_ROW = /^(\s*)(?:-[a-zA-Z],\s*)?(--[a-z][a-z0-9]*(?:-[a-z0-9]+)*)\b.*$/gm;

// commander: (choices: "a", "b")   clap: [possible values: a, b]
const CHOICES = /choices:\s*((?:"[^"]*"\s*,?\s*)+)|\[possible values:\s*([^\]]+)\]/g;

export function parseCliHelp(text) {
  const help = String(text ?? "");
  const rows = [...help.matchAll(OPTION_ROW)];
  const flags = new Set(rows.map((row) => row[2]));
  const choices = new Map();

  // Parse only within the option's own row/continuation block. This works for
  // both Claude's two-space Commander layout and Grok's six-space Clap layout,
  // without guessing a fixed indentation width.
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const flag = row[2];
    const start = row.index;
    const end = rows[index + 1]?.index ?? help.length;
    const block = help.slice(start, end);

    for (const match of block.matchAll(CHOICES)) {
      const values = match[1]
        ? [...match[1].matchAll(/"([^"]*)"/g)].map((item) => item[1])
        : match[2].split(",").map((value) => value.trim());
      const known = choices.get(flag) ?? new Set();
      for (const value of values.filter(Boolean)) { known.add(value); }
      choices.set(flag, known);
    }

    if (choices.has(flag)) { continue; }
    // Some CLIs document a choice list without the word "choices", for example
    // `--effort <level> ... (low, medium, high)`. Restrict this fallback to a
    // comma-separated list of identifier-like values so prose parentheses such
    // as "(only works with --print)" cannot become capabilities.
    const plain = /\(([a-zA-Z0-9_-]+(?:\s*,\s*[a-zA-Z0-9_-]+)+)\)/.exec(block)?.[1];
    if (plain) { choices.set(flag, new Set(plain.split(",").map((value) => value.trim()))); }
  }

  return { flags, choices, readable: flags.size > 0, text: help };
}

// Preserve "unknown" separately from "unsupported". Provider boundaries use
// `readable` to fail closed for exact settings; lower-level callers can still
// distinguish a failed probe from an advertised absence.
export const UNKNOWN_CAPABILITIES = { flags: new Set(), choices: new Map(), readable: false, text: "" };

const cache = new Map();

function cacheKey(bin, args) {
  try {
    const stat = statSync(bin);
    // An upgrade rewrites the binary, so mtime+size invalidates a stale answer
    // without needing to run the CLI again on every send.
    return `${bin}:${stat.mtimeMs}:${stat.size}:${JSON.stringify(args)}`;
  } catch {
    return `${bin}:${JSON.stringify(args)}`;
  }
}

export async function capabilitiesFor(bin, { args = ["--help"], timeoutMs = HELP_TIMEOUT_MS, label = bin } = {}) {
  if (!bin) { return UNKNOWN_CAPABILITIES; }

  const key = cacheKey(bin, args);
  const cached = cache.get(key);
  if (cached) { return cached; }

  const pending = new Promise((resolve) => {
    execFile(bin, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }, (_error, stdout, stderr) => {
      // Some CLIs print help to stderr, and some exit non-zero doing it.
      const parsed = parseCliHelp(`${stdout ?? ""}\n${stderr ?? ""}`);

      if (!parsed.readable) {
        cache.delete(key);
        console.error(`[${label}] could not read \`${args.join(" ")}\`; exact CLI settings remain unavailable until discovery succeeds`);
      }

      resolve(parsed);
    });
  });

  // Cache the in-flight probe too, so concurrent first sends do not launch the
  // same CLI twice. Unlike spawnSync, this never freezes SSE, queues, or UI API
  // calls while a slow provider prints help.
  cache.set(key, pending);
  return pending;
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

export function mergeCapabilities(...items) {
  const readable = items.some((caps) => caps?.readable);
  if (!readable) { return UNKNOWN_CAPABILITIES; }

  const flags = new Set();
  const choices = new Map();

  for (const caps of items) {
    if (!caps?.readable) { continue; }
    for (const flag of caps.flags) { flags.add(flag); }
    for (const [flag, values] of caps.choices) {
      const merged = choices.get(flag) ?? new Set();
      for (const value of values) { merged.add(value); }
      choices.set(flag, merged);
    }
  }

  return { flags, choices, readable: true, text: items.map((caps) => caps?.text ?? "").filter(Boolean).join("\n") };
}
