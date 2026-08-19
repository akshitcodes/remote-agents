import assert from "node:assert/strict";
import test from "node:test";

import { validateDispatchSettings, validateNewThreadModel } from "../dispatch-settings.mjs";

const MODELS = [{
  id: "gpt-5.6-sol",
  supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
}];

test("dispatch settings preserve the exact displayed Codex snapshot", () => {
  assert.deepEqual(validateDispatchSettings("codex", {
    model: "gpt-5.6-sol",
    effort: "high",
    mode: "auto",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  }, MODELS), {
    model: "gpt-5.6-sol",
    effort: "high",
    mode: "auto",
  });
});

test("missing model or effort fails closed instead of allowing provider defaults", () => {
  assert.throws(
    () => validateDispatchSettings("claude", { effort: "high", mode: "auto" }, []),
    (error) => error.code === "model_unavailable",
  );
  assert.throws(
    () => validateDispatchSettings("grok", { model: "grok-4.5", mode: "manual" }, [{ id: "grok-4.5" }]),
    (error) => error.code === "effort_unavailable",
  );
});

test("unsupported effort and mismatched Codex permission values are rejected", () => {
  assert.throws(
    () => validateDispatchSettings("codex", {
      model: "gpt-5.6-sol", effort: "ultra", mode: "auto", approvalPolicy: "on-request", sandbox: "workspace-write",
    }, MODELS),
    (error) => error.code === "effort_not_supported",
  );
  assert.throws(
    () => validateDispatchSettings("codex", {
      model: "gpt-5.6-sol", effort: "high", mode: "full", approvalPolicy: "on-request", sandbox: "workspace-write",
    }, MODELS),
    (error) => error.code === "permission_mode_mismatch",
  );
});

test("an exact provider-managed Codex policy is accepted only unchanged", () => {
  const policy = { type: "managed", file_system: { type: "restricted", entries: [] }, network: "restricted" };
  const recorded = {
    model: "gpt-5.6-sol", effort: "high", mode: null, modeKnown: false,
    approvalPolicy: "never", sandboxPolicy: policy,
    sources: { model: "codex_db", effort: "codex_db", mode: "codex_db" },
  };
  assert.deepEqual(validateDispatchSettings("codex", {
    model: "gpt-5.6-sol", effort: "high", mode: "provider-exact",
    approvalPolicy: "never", sandbox: policy,
  }, MODELS, recorded), {
    model: "gpt-5.6-sol", effort: "high", mode: "provider-exact",
  });
  assert.throws(() => validateDispatchSettings("codex", {
    model: "gpt-5.6-sol", effort: "high", mode: "provider-exact",
    approvalPolicy: "never", sandbox: { ...policy, network: "enabled" },
  }, MODELS, recorded), (error) => error.code === "permission_mode_mismatch");
});

test("provider-exact is Codex-only", () => {
  assert.throws(() => validateDispatchSettings("claude", {
    model: "claude-opus-5", effort: "high", mode: "provider-exact",
  }, [{ id: "claude-opus-5" }]), (error) => error.code === "permission_mode_unavailable");
});

test("an unlisted historical model is allowed only when the thread records the exact model and effort", () => {
  assert.deepEqual(validateDispatchSettings("claude", {
    model: "claude-opus-4-8", effort: "xhigh", mode: "auto",
  }, [], {
    model: "claude-opus-4-8", effort: "xhigh",
    sources: { model: "claude_transcript", effort: "claude_transcript" },
  }), {
    model: "claude-opus-4-8", effort: "xhigh", mode: "auto",
  });

  assert.throws(
    () => validateDispatchSettings("claude", {
      model: "claude-made-up", effort: "high", mode: "auto",
    }, [], { model: "claude-opus-4-8", effort: "high", sources: { model: "claude_transcript", effort: "claude_transcript" } }),
    (error) => error.code === "model_not_available",
  );

  assert.throws(
    () => validateDispatchSettings("claude", {
      model: "claude-opus-4-8", effort: "xhigh", mode: "auto",
    }, [], {
      model: "claude-opus-4-8", effort: "xhigh",
      sources: { model: "bridge_store", effort: "bridge_store" },
    }),
    (error) => error.code === "model_not_available",
  );
});

test("new sessions cannot silently fall back to a provider default", () => {
  assert.equal(validateNewThreadModel("codex", "gpt-5.6-sol", MODELS), "gpt-5.6-sol");
  assert.throws(
    () => validateNewThreadModel("codex", "", MODELS),
    (error) => error.code === "model_unavailable",
  );
  assert.throws(
    () => validateNewThreadModel("codex", "gpt-made-up", MODELS),
    (error) => error.code === "model_not_available",
  );
});
