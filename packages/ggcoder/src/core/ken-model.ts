/**
 * Ken's model selection — pure decision logic.
 *
 * Ken (chat mentor + autopilot reviewer) historically always adopted GG
 * Coder's model. Now each project can pin Ken to his OWN model:
 *
 *   - No override set → Ken follows GG Coder's model (including live switches).
 *   - Override set    → Ken uses it; GG Coder model switches no longer touch him.
 *
 * The sidecar persists the override per project (gg-app.json `kenModels`) and
 * wires the live sessions; this module owns validation + resolution so both
 * are unit-testable without booting the sidecar.
 */
import type { Provider } from "@kenkaiiii/gg-ai";

/** A pinned Ken model choice: provider + model id. */
export interface KenModelPref {
  provider: Provider;
  model: string;
}

/**
 * Validate a persisted (or requested) override before applying it. A stale
 * entry — model gone from the registry, or its provider no longer connected —
 * silently resolves to null so Ken falls back to following GG Coder instead
 * of erroring on every turn.
 */
export function validateKenModelPref(
  pref: KenModelPref | null | undefined,
  opts: { modelExists: (id: string) => boolean; providerConnected: (p: Provider) => boolean },
): KenModelPref | null {
  if (!pref || !pref.model || !pref.provider) return null;
  if (!opts.modelExists(pref.model)) return null;
  if (!opts.providerConnected(pref.provider)) return null;
  return pref;
}

/** What the footer needs to render `Ken <model>`: the model Ken will actually
 *  use next turn, plus whether that's a pin or just following GG Coder. */
export interface EffectiveKenModel {
  kenProvider: Provider;
  kenModel: string;
  /** True when a user-set override is active (not following GG Coder). */
  kenModelOverride: boolean;
}

/**
 * Resolve the model Ken uses right now: the override when set, otherwise the
 * build session's current model.
 */
export function effectiveKenModel(
  override: KenModelPref | null,
  build: { provider: Provider; model: string },
): EffectiveKenModel {
  if (override) {
    return { kenProvider: override.provider, kenModel: override.model, kenModelOverride: true };
  }
  return { kenProvider: build.provider, kenModel: build.model, kenModelOverride: false };
}
