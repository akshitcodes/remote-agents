import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { localControlProof, localControlProofMatches } from "../local-proof.mjs";
import { TerminalSecurity } from "../terminal-security.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "remote-agents-terminal-security-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "security.json");
}

function mockWebauthn({ pauseRegistration = null } = {}) {
  return {
    generateRegistrationOptions: async () => ({ challenge: "registration-challenge" }),
    verifyRegistrationResponse: async () => {
      if (pauseRegistration) { await pauseRegistration; }
      return {
        verified: true,
        registrationInfo: {
          userVerified: true,
          credentialDeviceType: "multiDevice",
          credentialBackedUp: true,
          credential: { id: "credential-1", publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"] },
        },
      };
    },
    generateAuthenticationOptions: async () => ({ challenge: "authentication-challenge" }),
    verifyAuthenticationResponse: async () => ({
      verified: true,
      authenticationInfo: { userVerified: true, newCounter: 2 },
    }),
  };
}

async function enroll(security, enrollment, browserSecret = "browser-one") {
  const options = await security.registrationOptions({ capability: enrollment.secret, browserSecret, label: "Phone" });
  return security.verifyRegistration({ ceremonyId: options.ceremonyId, response: { id: "response" }, browserSecret });
}

test("terminal enrollment binds a passkey to one browser and tickets are one-use", async (t) => {
  let now = 1000;
  const security = new TerminalSecurity({
    file: fixture(t), origin: "https://agents.example.test", now: () => now, webauthn: mockWebauthn(),
  });
  const enrollment = security.createEnrollment();
  const registered = await enroll(security, enrollment);
  assert.equal(registered.device.label, "Phone");
  assert.equal(security.status({ browserSecret: "browser-one", unlockToken: registered.unlockToken }).unlocked, true);
  assert.equal(security.status({ browserSecret: "browser-two", unlockToken: registered.unlockToken }).unlocked, false);

  const issued = security.issueTicket({
    unlockToken: registered.unlockToken,
    browserSecret: "browser-one",
    context: { provider: "codex", threadId: "thread-1", cwd: "/tmp/project" },
  });
  assert.equal(security.consumeTicket(issued.ticket, "browser-one").context.threadId, "thread-1");
  assert.throws(() => security.consumeTicket(issued.ticket, "browser-one"), (error) => error.code === "terminal_ticket_invalid");

  now += 16 * 60 * 1000;
  assert.throws(() => security.requireUnlock(registered.unlockToken, "browser-one"), (error) => error.code === "terminal_unlock_required");
});

test("authentication refreshes the unlock and device revocation invalidates access", async (t) => {
  const invalidations = [];
  const security = new TerminalSecurity({
    file: fixture(t), origin: "https://agents.example.test", webauthn: mockWebauthn(), onInvalidate: (event) => invalidations.push(event),
  });
  const registered = await enroll(security, security.createEnrollment());
  const options = await security.authenticationOptions({ browserSecret: "browser-one" });
  const authenticated = await security.verifyAuthentication({ ceremonyId: options.ceremonyId, response: { id: "assertion" }, browserSecret: "browser-one" });
  assert.equal(security.requireUnlock(authenticated.unlockToken, "browser-one").device.credential.counter, 2);
  security.revokeDevice(registered.device.id);
  assert.throws(() => security.requireUnlock(authenticated.unlockToken, "browser-one"), (error) => ["terminal_unlock_required", "terminal_revoked"].includes(error.code));
  assert.deepEqual(invalidations[0].deviceIds, [registered.device.id]);
  assert.throws(() => security.requireDevice(registered.device.id), (error) => error.code === "terminal_revoked");
  assert.equal(JSON.parse(readFileSync(security.file, "utf8")).devices.length, 0);
});

test("disable wins a race with asynchronous passkey registration", async (t) => {
  let release;
  const paused = new Promise((resolve) => { release = resolve; });
  const security = new TerminalSecurity({
    file: fixture(t), origin: "https://agents.example.test", webauthn: mockWebauthn({ pauseRegistration: paused }),
  });
  const enrollment = security.createEnrollment();
  const options = await security.registrationOptions({ capability: enrollment.secret, browserSecret: "browser-one", label: "Phone" });
  const verification = security.verifyRegistration({ ceremonyId: options.ceremonyId, response: {}, browserSecret: "browser-one" });
  await new Promise((resolve) => setImmediate(resolve));
  security.disable();
  release();
  await assert.rejects(verification, (error) => error.code === "terminal_security_changed");
});

test("local terminal administration proof covers both nonce and exact body", () => {
  const token = "pairing-secret";
  const nonce = "a".repeat(64);
  const body = JSON.stringify({ action: "enable" });
  const proof = localControlProof(token, nonce, body);
  assert.equal(localControlProofMatches(token, nonce, body, proof), true);
  assert.equal(localControlProofMatches(token, nonce, JSON.stringify({ action: "disable" }), proof), false);
  assert.equal(localControlProofMatches(token, "b".repeat(64), body, proof), false);
});
