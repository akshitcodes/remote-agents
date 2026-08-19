// codex-phone — Web Push ("your agent finished") for the installed PWA.
//
// iOS 16.4+ delivers Web Push to home-screen web apps through Apple's own push
// service, so this needs no Apple developer account, no native app and no relay:
// standard VAPID against whatever endpoint the browser hands us.
//
// Keys live in ~/.codex-phone/config.json (generated once); subscriptions in
// ~/.codex-phone/push.json. A subscription that the push service rejects as
// gone (404/410) is pruned automatically.

import webpush from "web-push";
import { readConfig, readJson, writeConfig, writeJson } from "./config.mjs";

// VAPID "sub" — the contact the push service can reach. Apple validates this and
// rejects the whole JWT with 403 BadJwtToken if it is not a real mailto: address
// or https: URL (a .local or made-up domain fails). Override with `pushSubject`
// in ~/.codex-phone/config.json to point at your own address.
const DEFAULT_SUBJECT = "https://github.com/akshitcodes/remote-agents";

let keys = null;
let subs = [];

// Generate the VAPID pair on first use and persist it, so existing devices stay
// subscribed across restarts.
export function init() {
  const cfg = readConfig();

  if (cfg.vapid?.publicKey && cfg.vapid?.privateKey) {
    keys = cfg.vapid;
  } else {
    keys = webpush.generateVAPIDKeys();
    writeConfig({ ...cfg, vapid: keys });
    console.error("[push] generated VAPID keys");
  }

  webpush.setVapidDetails(cfg.pushSubject || DEFAULT_SUBJECT, keys.publicKey, keys.privateKey);
  subs = readJson("push.json", []);
}

export function publicKey() {
  return keys?.publicKey ?? null;
}

export function count() {
  return subs.length;
}

export function has(endpoint) {
  return !!endpoint && subs.some((sub) => sub.endpoint === endpoint);
}

export function subscribe(sub) {
  if (!sub?.endpoint) {
    throw Object.assign(new Error("subscription with an endpoint is required"), { status: 400 });
  }

  subs = subs.filter((s) => s.endpoint !== sub.endpoint);
  subs.push(sub);
  writeJson("push.json", subs);
  return { ok: true, subscribers: subs.length };
}

export function unsubscribe(endpoint) {
  const before = subs.length;
  subs = subs.filter((s) => s.endpoint !== endpoint);

  if (subs.length !== before) {
    writeJson("push.json", subs);
  }

  return { ok: true, subscribers: subs.length };
}

// Fire and forget: a dead subscription is dropped, other failures are logged.
export async function send(payload, { endpoints } = {}) {
  if (!keys || !subs.length) {
    return { sent: 0 };
  }

  const body = JSON.stringify(payload);
  const dead = [];
  let sent = 0;
  const wanted = endpoints === undefined ? null : new Set(endpoints);
  const targets = wanted ? subs.filter((sub) => wanted.has(sub.endpoint)) : subs;

  await Promise.all(targets.map(async (sub) => {
    try {
      await webpush.sendNotification(sub, body);
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        dead.push(sub.endpoint);
      } else {
        console.error(`[push] send failed (${e.statusCode ?? "?"}): ${e.message}`);
      }
    }
  }));

  if (dead.length) {
    subs = subs.filter((s) => !dead.includes(s.endpoint));
    writeJson("push.json", subs);
    console.error(`[push] pruned ${dead.length} expired subscription(s)`);
  }

  return { sent };
}
