// Passkey-backed authorization for remote shell access.
//
// The ordinary app pairing token intentionally remains convenient and shared.
// Shell access is a separate capability: a locally-created enrollment whitelists
// one browser instance + WebAuthn credential, and a fresh assertion creates a
// short-lived in-memory unlock lease. No private credential or terminal token is
// persisted.

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";

const STATE_VERSION = 1;
const ENROLLMENT_TTL_MS = 5 * 60 * 1000;
const CEREMONY_TTL_MS = 2 * 60 * 1000;
const UNLOCK_IDLE_TTL_MS = 15 * 60 * 1000;
const UNLOCK_ABSOLUTE_TTL_MS = 2 * 60 * 60 * 1000;
const TICKET_TTL_MS = 45 * 1000;
const MAX_EPHEMERAL = 128;

function terminalError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function hash(value) {
  return createHash("sha256").update(String(value ?? "")).digest("base64url");
}

function equalHash(left, right) {
  const a = Buffer.from(String(left ?? ""));
  const b = Buffer.from(String(right ?? ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function token(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function cleanLabel(value) {
  const label = String(value ?? "").trim().replace(/\s+/g, " ");
  return (label || "My device").slice(0, 80);
}

function cleanCode(value) {
  return String(value ?? "").replace(/[^0-9]/g, "").slice(0, 8);
}

function initialState() {
  return {
    version: STATE_VERSION,
    enabled: false,
    epoch: 0,
    userId: token(32),
    devices: [],
  };
}

function validateState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.version !== STATE_VERSION || typeof value.enabled !== "boolean"
      || !Number.isInteger(value.epoch) || typeof value.userId !== "string"
      || !Array.isArray(value.devices)) {
    throw terminalError("terminal security state is invalid; shell access is disabled until it is repaired locally", "terminal_state_invalid", 503);
  }

  for (const device of value.devices) {
    if (!device || typeof device !== "object" || typeof device.id !== "string"
        || typeof device.browserHash !== "string" || typeof device.credential?.id !== "string"
        || typeof device.credential?.publicKey !== "string" || !Number.isInteger(device.credential?.counter)
        || !Number.isInteger(device.generation) || typeof device.origin !== "string" || typeof device.rpId !== "string") {
      throw terminalError("terminal security state contains an invalid device; shell access is disabled until it is repaired locally", "terminal_state_invalid", 503);
    }
  }

  return value;
}

function readState(file) {
  if (!existsSync(file)) { return initialState(); }
  try {
    return validateState(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    if (error?.code === "terminal_state_invalid") { throw error; }
    throw terminalError(`terminal security state could not be read: ${error.message}`, "terminal_state_invalid", 503);
  }
}

function writeState(file, state) {
  const dir = dirname(file);
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch {}
  writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, file);
  try { chmodSync(file, 0o600); } catch {}
}

function publicDevice(device) {
  return {
    id: device.id,
    label: device.label,
    createdAt: device.createdAt,
    lastUsedAt: device.lastUsedAt ?? null,
    credentialBackedUp: device.credentialBackedUp === true,
    credentialDeviceType: device.credentialDeviceType ?? null,
  };
}

export class TerminalSecurity {
  constructor({
    file,
    origin = null,
    now = Date.now,
    webauthn = {},
    onInvalidate = () => {},
  } = {}) {
    if (!file) { throw new Error("terminal security file is required"); }
    this.file = file;
    this.origin = origin ? new URL(origin).origin : null;
    this.rpId = this.origin ? new URL(this.origin).hostname : null;
    this.now = now;
    this.webauthn = {
      generateRegistrationOptions: webauthn.generateRegistrationOptions ?? generateRegistrationOptions,
      verifyRegistrationResponse: webauthn.verifyRegistrationResponse ?? verifyRegistrationResponse,
      generateAuthenticationOptions: webauthn.generateAuthenticationOptions ?? generateAuthenticationOptions,
      verifyAuthenticationResponse: webauthn.verifyAuthenticationResponse ?? verifyAuthenticationResponse,
    };
    this.onInvalidate = onInvalidate;
    this.enrollments = new Map();
    this.registrationChallenges = new Map();
    this.authenticationChallenges = new Map();
    this.unlocks = new Map();
    this.tickets = new Map();
    this.badEnrollmentAttempts = [];
  }

  configureOrigin(origin) {
    this.origin = origin ? new URL(origin).origin : null;
    this.rpId = this.origin ? new URL(this.origin).hostname : null;
  }

  state() {
    return readState(this.file);
  }

  save(state) {
    validateState(state);
    writeState(this.file, state);
  }

  prune() {
    const now = this.now();
    for (const map of [this.enrollments, this.registrationChallenges, this.authenticationChallenges, this.tickets]) {
      for (const [key, value] of map) {
        if (value.expiresAt <= now) { map.delete(key); }
      }
      while (map.size > MAX_EPHEMERAL) { map.delete(map.keys().next().value); }
    }
    for (const [key, lease] of this.unlocks) {
      if (lease.absoluteExpiresAt <= now || lease.lastUsedAt + UNLOCK_IDLE_TTL_MS <= now) { this.unlocks.delete(key); }
    }
    while (this.unlocks.size > MAX_EPHEMERAL) { this.unlocks.delete(this.unlocks.keys().next().value); }
    this.badEnrollmentAttempts = this.badEnrollmentAttempts.filter((at) => now - at < 60_000);
  }

  requireOrigin() {
    if (!this.origin || !this.rpId) {
      throw terminalError("a verified stable HTTPS address is required before terminal passkeys can be enabled", "terminal_origin_unavailable", 409);
    }
    if (new URL(this.origin).protocol !== "https:" && this.rpId !== "localhost") {
      throw terminalError("terminal passkeys require HTTPS", "terminal_origin_unavailable", 409);
    }
  }

  status({ browserSecret, unlockToken } = {}) {
    this.prune();
    const state = this.state();
    const device = browserSecret ? state.devices.find((item) => equalHash(item.browserHash, hash(browserSecret))) : null;
    let unlocked = false;
    if (unlockToken && device) {
      try { this.requireUnlock(unlockToken, browserSecret); unlocked = true; } catch {}
    }
    return {
      enabled: state.enabled,
      originReady: !!this.origin,
      enrolled: !!device,
      device: device ? publicDevice(device) : null,
      unlocked,
      unlockIdleSeconds: Math.floor(UNLOCK_IDLE_TTL_MS / 1000),
    };
  }

  createEnrollment() {
    this.requireOrigin();
    const state = this.state();
    state.enabled = true;
    this.save(state);
    this.prune();
    const id = token(18);
    const secret = token(32);
    const code = String(randomInt(0, 100_000_000)).padStart(8, "0");
    const enrollment = {
      id,
      secretHash: hash(secret),
      codeHash: hash(code),
      attemptsLeft: 5,
      epoch: state.epoch,
      expiresAt: this.now() + ENROLLMENT_TTL_MS,
    };
    this.enrollments.set(id, enrollment);
    return { secret, code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt: enrollment.expiresAt, origin: this.origin };
  }

  listDevices() {
    const state = this.state();
    return { enabled: state.enabled, devices: state.devices.map(publicDevice) };
  }

  revokeDevice(deviceId) {
    const state = this.state();
    const before = state.devices.length;
    state.devices = state.devices.filter((device) => device.id !== deviceId);
    if (state.devices.length === before) { throw terminalError("terminal device not found", "terminal_device_not_found", 404); }
    this.save(state);
    this.invalidateDevices([deviceId], "device revoked");
    return this.listDevices();
  }

  disable() {
    const state = this.state();
    const ids = state.devices.map((device) => device.id);
    state.enabled = false;
    state.epoch += 1;
    state.devices = [];
    this.save(state);
    this.enrollments.clear();
    this.registrationChallenges.clear();
    this.authenticationChallenges.clear();
    this.unlocks.clear();
    this.tickets.clear();
    this.onInvalidate({ deviceIds: ids, all: true, reason: "terminal access disabled" });
    return { enabled: false, devices: [] };
  }

  invalidateDevices(deviceIds, reason) {
    const set = new Set(deviceIds);
    for (const [key, lease] of this.unlocks) {
      if (set.has(lease.deviceId)) { this.unlocks.delete(key); }
    }
    for (const [key, ticket] of this.tickets) {
      if (set.has(ticket.deviceId)) { this.tickets.delete(key); }
    }
    for (const [key, ceremony] of this.authenticationChallenges) {
      if (set.has(ceremony.deviceId)) { this.authenticationChallenges.delete(key); }
    }
    this.onInvalidate({ deviceIds: [...set], all: false, reason });
  }

  findEnrollment(capability) {
    this.prune();
    const supplied = String(capability ?? "").trim();
    const numericCode = /^[0-9\s-]+$/.test(supplied) && cleanCode(supplied).length === 8
      ? cleanCode(supplied)
      : null;
    const suppliedHash = hash(numericCode ?? supplied);
    const enrollment = [...this.enrollments.values()].find((item) => equalHash(item.secretHash, suppliedHash) || equalHash(item.codeHash, suppliedHash));
    if (enrollment) { return enrollment; }

    this.badEnrollmentAttempts.push(this.now());
    if (this.badEnrollmentAttempts.length >= 5) {
      throw terminalError("too many invalid terminal enrollment attempts; try again in one minute", "terminal_enrollment_rate_limited", 429);
    }
    throw terminalError("terminal enrollment code is invalid or expired", "terminal_enrollment_invalid", 403);
  }

  async registrationOptions({ capability, browserSecret, label } = {}) {
    this.requireOrigin();
    const state = this.state();
    if (!state.enabled) { throw terminalError("terminal access is disabled", "terminal_disabled", 403); }
    if (!browserSecret) { throw terminalError("browser identity is required", "terminal_browser_required", 401); }
    const enrollment = this.findEnrollment(capability);
    if (enrollment.epoch !== state.epoch) { throw terminalError("terminal enrollment expired after a security change", "terminal_enrollment_invalid", 403); }
    const browserHash = hash(browserSecret);
    const options = await this.webauthn.generateRegistrationOptions({
      rpName: "Remote Agents terminal",
      rpID: this.rpId,
      userName: "remote-agents-terminal",
      userDisplayName: cleanLabel(label),
      userID: Buffer.from(state.userId, "base64url"),
      timeout: 60_000,
      attestationType: "none",
      excludeCredentials: state.devices.map((device) => ({ id: device.credential.id, transports: device.credential.transports ?? [] })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      supportedAlgorithmIDs: [-7, -257],
    });
    const ceremonyId = token(24);
    this.registrationChallenges.set(ceremonyId, {
      challenge: options.challenge,
      browserHash,
      enrollmentId: enrollment.id,
      epoch: state.epoch,
      label: cleanLabel(label),
      expiresAt: this.now() + CEREMONY_TTL_MS,
    });
    return { ceremonyId, options };
  }

  async verifyRegistration({ ceremonyId, response, browserSecret } = {}) {
    this.prune();
    const ceremony = this.registrationChallenges.get(String(ceremonyId ?? ""));
    this.registrationChallenges.delete(String(ceremonyId ?? ""));
    if (!ceremony || !browserSecret || !equalHash(ceremony.browserHash, hash(browserSecret))) {
      throw terminalError("terminal registration ceremony is invalid or expired", "terminal_ceremony_invalid", 403);
    }
    const enrollment = this.enrollments.get(ceremony.enrollmentId);
    if (!enrollment) { throw terminalError("terminal enrollment is no longer available", "terminal_enrollment_invalid", 403); }
    const before = this.state();
    if (!before.enabled || before.epoch !== ceremony.epoch || enrollment.epoch !== before.epoch) {
      throw terminalError("terminal access changed during registration", "terminal_security_changed", 409);
    }

    const verification = await this.webauthn.verifyRegistrationResponse({
      response,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpId,
      requireUserVerification: true,
    });
    if (!verification?.verified || !verification.registrationInfo?.userVerified) {
      throw terminalError("the passkey did not verify device authentication", "terminal_passkey_rejected", 403);
    }

    // Re-read after the asynchronous cryptographic verification. Revocation or
    // disable wins the race and cannot mint a usable terminal credential.
    const state = this.state();
    if (!state.enabled || state.epoch !== ceremony.epoch || !this.enrollments.has(ceremony.enrollmentId)) {
      throw terminalError("terminal access changed during registration", "terminal_security_changed", 409);
    }
    const info = verification.registrationInfo;
    if (state.devices.some((device) => device.credential.id === info.credential.id)) {
      throw terminalError("this passkey is already registered", "terminal_credential_exists", 409);
    }
    const device = {
      id: token(18),
      label: ceremony.label,
      browserHash: ceremony.browserHash,
      generation: 1,
      origin: this.origin,
      rpId: this.rpId,
      createdAt: this.now(),
      lastUsedAt: null,
      credentialDeviceType: info.credentialDeviceType ?? null,
      credentialBackedUp: info.credentialBackedUp === true,
      credential: {
        id: info.credential.id,
        publicKey: Buffer.from(info.credential.publicKey).toString("base64url"),
        counter: Number(info.credential.counter) || 0,
        transports: info.credential.transports ?? [],
      },
    };
    state.devices.push(device);
    this.save(state);
    this.enrollments.delete(ceremony.enrollmentId);
    const unlockToken = this.createUnlock(device, state);
    return { device: publicDevice(device), unlockToken, idleExpiresIn: UNLOCK_IDLE_TTL_MS };
  }

  browserDevice(state, browserSecret) {
    if (!browserSecret) { return null; }
    const browserHash = hash(browserSecret);
    return state.devices.find((device) => equalHash(device.browserHash, browserHash)) ?? null;
  }

  async authenticationOptions({ browserSecret } = {}) {
    this.requireOrigin();
    const state = this.state();
    if (!state.enabled) { throw terminalError("terminal access is disabled", "terminal_disabled", 403); }
    const device = this.browserDevice(state, browserSecret);
    if (!device) { throw terminalError("this browser is not enrolled for terminal access", "terminal_enrollment_required", 403); }
    if (device.origin !== this.origin || device.rpId !== this.rpId) {
      throw terminalError("the terminal address changed; re-enroll this browser locally", "terminal_origin_changed", 409);
    }
    const options = await this.webauthn.generateAuthenticationOptions({
      rpID: this.rpId,
      timeout: 60_000,
      allowCredentials: [{ id: device.credential.id, transports: device.credential.transports ?? [] }],
      userVerification: "required",
    });
    const ceremonyId = token(24);
    this.authenticationChallenges.set(ceremonyId, {
      challenge: options.challenge,
      browserHash: device.browserHash,
      deviceId: device.id,
      deviceGeneration: device.generation,
      epoch: state.epoch,
      expiresAt: this.now() + CEREMONY_TTL_MS,
    });
    return { ceremonyId, options };
  }

  async verifyAuthentication({ ceremonyId, response, browserSecret } = {}) {
    this.prune();
    const key = String(ceremonyId ?? "");
    const ceremony = this.authenticationChallenges.get(key);
    this.authenticationChallenges.delete(key);
    if (!ceremony || !browserSecret || !equalHash(ceremony.browserHash, hash(browserSecret))) {
      throw terminalError("terminal authentication ceremony is invalid or expired", "terminal_ceremony_invalid", 403);
    }
    const before = this.state();
    const device = before.devices.find((item) => item.id === ceremony.deviceId && item.generation === ceremony.deviceGeneration);
    if (!before.enabled || before.epoch !== ceremony.epoch || !device) {
      throw terminalError("terminal access changed during authentication", "terminal_security_changed", 409);
    }
    const verification = await this.webauthn.verifyAuthenticationResponse({
      response,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpId,
      requireUserVerification: true,
      credential: {
        id: device.credential.id,
        publicKey: Buffer.from(device.credential.publicKey, "base64url"),
        counter: device.credential.counter,
        transports: device.credential.transports ?? [],
      },
    });
    if (!verification?.verified || !verification.authenticationInfo?.userVerified) {
      throw terminalError("the passkey did not verify device authentication", "terminal_passkey_rejected", 403);
    }

    const state = this.state();
    const current = state.devices.find((item) => item.id === ceremony.deviceId && item.generation === ceremony.deviceGeneration);
    if (!state.enabled || state.epoch !== ceremony.epoch || !current) {
      throw terminalError("terminal access changed during authentication", "terminal_security_changed", 409);
    }
    current.credential.counter = Math.max(current.credential.counter, Number(verification.authenticationInfo.newCounter) || 0);
    current.lastUsedAt = this.now();
    this.save(state);

    const unlockToken = this.createUnlock(current, state);
    return { unlockToken, device: publicDevice(current), idleExpiresIn: UNLOCK_IDLE_TTL_MS };
  }

  createUnlock(device, state) {
    const unlockToken = token(32);
    const now = this.now();
    this.unlocks.set(hash(unlockToken), {
      id: token(18),
      deviceId: device.id,
      browserHash: device.browserHash,
      deviceGeneration: device.generation,
      epoch: state.epoch,
      createdAt: now,
      lastUsedAt: now,
      absoluteExpiresAt: now + UNLOCK_ABSOLUTE_TTL_MS,
    });
    return unlockToken;
  }

  requireUnlock(unlockToken, browserSecret, { touch = true } = {}) {
    this.prune();
    const lease = this.unlocks.get(hash(unlockToken));
    if (!lease || !browserSecret || !equalHash(lease.browserHash, hash(browserSecret))) {
      throw terminalError("terminal unlock expired; verify your passkey again", "terminal_unlock_required", 401);
    }
    const state = this.state();
    const device = state.enabled
      ? state.devices.find((item) => item.id === lease.deviceId && item.generation === lease.deviceGeneration)
      : null;
    if (!device || state.epoch !== lease.epoch) {
      this.unlocks.delete(hash(unlockToken));
      throw terminalError("terminal access was revoked", "terminal_revoked", 403);
    }
    if (touch) { lease.lastUsedAt = this.now(); }
    return { lease, device, state };
  }

  requireDevice(deviceId) {
    const state = this.state();
    const device = state.enabled ? state.devices.find((item) => item.id === deviceId) : null;
    if (!device) { throw terminalError("terminal device was revoked", "terminal_revoked", 403); }
    return device;
  }

  issueTicket({ unlockToken, browserSecret, context } = {}) {
    const { lease, device } = this.requireUnlock(unlockToken, browserSecret);
    const ticket = token(32);
    this.tickets.set(hash(ticket), {
      deviceId: device.id,
      leaseId: lease.id,
      browserHash: device.browserHash,
      context: structuredClone(context),
      expiresAt: this.now() + TICKET_TTL_MS,
    });
    return { ticket, expiresIn: TICKET_TTL_MS };
  }

  consumeTicket(ticket, browserSecret) {
    this.prune();
    const key = hash(ticket);
    const value = this.tickets.get(key);
    this.tickets.delete(key);
    if (!value || !browserSecret || !equalHash(value.browserHash, hash(browserSecret))) {
      throw terminalError("terminal connection ticket is invalid or already used", "terminal_ticket_invalid", 403);
    }
    this.requireDevice(value.deviceId);
    return value;
  }
}

export const terminalSecurityInternals = {
  hash,
  initialState,
  validateState,
  ENROLLMENT_TTL_MS,
  CEREMONY_TTL_MS,
  UNLOCK_IDLE_TTL_MS,
  TICKET_TTL_MS,
};
