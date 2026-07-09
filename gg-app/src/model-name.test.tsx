// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { modelDisplayName } from "./model-name";
import { ModelMenu } from "./ModelMenu";
import type { ModelOption } from "./agent";

// ModelMenu only imports ModelOption from ./agent as a type (erased), so the
// module's Tauri side-effects never load. Guard anyway in case that changes.
vi.mock("./agent", () => ({}));

const MODELS: ModelOption[] = [
  { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite", provider: "gemini" },
  { id: "gemini-3-flash", name: "Gemini 3.5 Flash", provider: "gemini" },
];

afterEach(cleanup);

describe("modelDisplayName (footer label)", () => {
  it("maps the gemini-3-flash wire id to the friendly 'Gemini 3.5 Flash'", () => {
    expect(modelDisplayName(MODELS, "gemini-3-flash")).toBe("Gemini 3.5 Flash");
  });

  it("falls back to the raw id when the model isn't in the list", () => {
    expect(modelDisplayName(MODELS, "unknown-model")).toBe("unknown-model");
  });

  it("shows an ellipsis when there is no id yet", () => {
    expect(modelDisplayName(MODELS, undefined)).toBe("\u2026");
    expect(modelDisplayName(MODELS, null)).toBe("\u2026");
  });
});

describe("ModelMenu (dropdown)", () => {
  it("renders friendly names, not raw wire ids", () => {
    render(
      <ModelMenu
        models={MODELS}
        currentModel="gemini-3-flash"
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    // The button label is the friendly name…
    expect(screen.getByText("Gemini 3.5 Flash")).toBeDefined();
    // …and the raw wire id is never shown as visible text.
    expect(screen.queryByText("gemini-3-flash")).toBeNull();
  });
});
