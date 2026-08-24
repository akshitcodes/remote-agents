const MAX_CAPTURE_CHARS = 400;
const MAX_BODY_CHARS = 180;
const MAX_TITLE_CHARS = 80;

function compact(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

// Preserve the beginning of a streaming answer. Keeping a rolling tail makes
// the notification start halfway through the final response once it grows.
export function captureReplyStart(existing, delta) {
  const current = String(existing ?? "");

  if (current.length >= MAX_CAPTURE_CHARS) { return current; }

  return (current + String(delta ?? "")).slice(0, MAX_CAPTURE_CHARS);
}

export function notificationTitle(threadTitle) {
  return compact(threadTitle).slice(0, MAX_TITLE_CHARS) || "Thread update";
}

export function notificationBody(reply, { failed = false, errorText = "" } = {}) {
  if (failed) {
    return compact(errorText).slice(0, MAX_BODY_CHARS) || "Turn failed";
  }

  return compact(reply).slice(0, MAX_BODY_CHARS) || "Turn finished";
}
