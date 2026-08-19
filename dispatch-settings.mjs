import { codexModeKey, isKnownMode } from "./thread-settings.mjs";

function invalid(message, code = "invalid_dispatch_settings") {
  return Object.assign(new Error(message), { status: 409, code });
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

// Build the exact, validated settings snapshot that is allowed to cross the
// provider boundary. Missing values fail closed: silently omitting --model or
// an RPC model field would let a CLI choose a default that contradicts the UI.
export function validateDispatchSettings(providerName, body, models, resolvedThreadSettings = null) {
  const model = clean(body?.model);
  const effort = clean(body?.effort);
  const mode = clean(body?.mode);

  if (!model) { throw invalid("Model is unavailable. Reload the thread before sending.", "model_unavailable"); }
  if (!effort) { throw invalid("Reasoning effort is unavailable. Reload the thread before sending.", "effort_unavailable"); }
  const providerExactMode = providerName === "codex" && mode === "provider-exact";
  if (!isKnownMode(providerName, mode) && !providerExactMode) {
    throw invalid("Permission mode is unavailable or does not match this provider.", "permission_mode_unavailable");
  }

  const advertised = (models ?? []).find((candidate) => candidate?.id === model);

  // Historical threads can legitimately use a full model ID no longer present
  // in today's picker. Permit it only when the provider transcript/database or
  // our durable per-thread selection says this exact ID belongs to the thread.
  const providerModel = resolvedThreadSettings?.providerConfirmed?.model;
  const modelConfirmedByProvider = providerModel === model || (
    resolvedThreadSettings?.model === model
    && resolvedThreadSettings?.sources?.model
    && !resolvedThreadSettings.sources.model.startsWith("bridge_")
  );
  if (!advertised && !modelConfirmedByProvider) {
    throw invalid(`Model ${model} is not advertised by ${providerName} and is not this thread's recorded model.`, "model_not_available");
  }

  const efforts = advertised?.supportedReasoningEfforts ?? [];
  if (efforts.length && !efforts.some((candidate) => candidate?.reasoningEffort === effort)) {
    throw invalid(`Effort ${effort} is not supported by model ${model}.`, "effort_not_supported");
  }

  const providerEffort = resolvedThreadSettings?.providerConfirmed?.effort;
  const recordedEffortMatches = providerModel === model
    ? providerEffort === effort
    : resolvedThreadSettings?.effort === effort;
  if (!advertised && !recordedEffortMatches) {
    throw invalid(`Effort ${effort} does not match this unlisted model's recorded effort.`, "effort_not_supported");
  }

  if (providerName === "codex") {
    if (providerExactMode) {
      const providerOwned = resolvedThreadSettings?.modeKnown === false
        && resolvedThreadSettings?.sources?.mode
        && !resolvedThreadSettings.sources.mode.startsWith("bridge_");
      if (!providerOwned
          || body?.approvalPolicy !== resolvedThreadSettings.approvalPolicy
          || !sameJson(body?.sandbox, resolvedThreadSettings.sandboxPolicy)) {
        throw invalid("The exact provider-owned Codex permission policy changed. Reload before sending.", "permission_mode_mismatch");
      }
    } else if (codexModeKey(body?.approvalPolicy, body?.sandbox) !== mode) {
      throw invalid("The displayed Codex permission mode does not match the approval and sandbox values being dispatched.", "permission_mode_mismatch");
    }
  }

  return { model, effort, mode };
}

export function validateNewThreadModel(providerName, modelValue, models) {
  const model = clean(modelValue);
  if (!model) { throw invalid("Model is unavailable. Reload models before creating a session.", "model_unavailable"); }
  if (!(models ?? []).some((candidate) => candidate?.id === model)) {
    throw invalid(`Model ${model} is not currently advertised by ${providerName}.`, "model_not_available");
  }
  return model;
}
