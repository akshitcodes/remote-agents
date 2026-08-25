import { createHmac, timingSafeEqual } from "node:crypto";

const NONCE_PATTERN = /^[a-f0-9]{64}$/;

export function validLocalProofNonce(value) {
  return NONCE_PATTERN.test(String(value ?? ""));
}

export function localBridgeProof(token, nonce) {
  if (!validLocalProofNonce(nonce)) { throw new Error("invalid local proof nonce"); }
  return createHmac("sha256", String(token)).update(`remote-agents-local-proof:${nonce}`).digest("base64url");
}

export function localBridgeProofMatches(token, nonce, candidate) {
  if (!validLocalProofNonce(nonce) || typeof candidate !== "string") { return false; }
  const expected = Buffer.from(localBridgeProof(token, nonce));
  const supplied = Buffer.from(candidate);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
