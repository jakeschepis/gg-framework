// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ModelSelect } from "./ModelSelect";
import { supportsNativeSelectPopup } from "./platform";
import type { ModelOption } from "./agent";

vi.mock("./platform", () => ({ supportsNativeSelectPopup: vi.fn() }));

const supportsNativeMock = vi.mocked(supportsNativeSelectPopup);

const MODELS: ModelOption[] = [
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "anthropic" },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
  { id: "grok-4.5", name: "Grok 4.5", provider: "xai" },
  {
    id: "local/ollama/gemma4:e2b",
    name: "gemma4:e2b (Ollama)",
    provider: "local",
    local: true,
    endpoint: "Ollama",
    supportsTools: true,
    contextWindow: 131072,
  },
  {
    id: "local/ollama/tiny",
    name: "tiny (Ollama)",
    provider: "local",
    local: true,
    endpoint: "Ollama",
    supportsTools: false,
    contextWindow: 8192,
  },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ModelSelect — native popup", () => {
  it("groups every provider under its own label, local last", () => {
    supportsNativeMock.mockReturnValue(true);
    render(
      <ModelSelect
        models={MODELS}
        currentModel="claude-sonnet-5"
        onSelect={vi.fn()}
        title="Switch model"
      />,
    );

    const groups = Array.from(document.querySelectorAll("optgroup")).map((g) => g.label);
    expect(groups).toEqual(["Anthropic", "OpenAI", "xAI (Grok)", "Local"]);
  });

  it("disables a tool-less local option and says why in its label", () => {
    supportsNativeMock.mockReturnValue(true);
    render(
      <ModelSelect
        models={MODELS}
        currentModel="claude-sonnet-5"
        onSelect={vi.fn()}
        title="Switch model"
      />,
    );

    const option = screen.getByRole("option", { name: /tiny \(Ollama\) — no tool calling/ });
    expect(option.hasAttribute("disabled")).toBe(true);
  });

  it("names the endpoint in the tooltip while a local model is active", () => {
    supportsNativeMock.mockReturnValue(true);
    render(
      <ModelSelect
        models={MODELS}
        currentModel="local/ollama/gemma4:e2b"
        onSelect={vi.fn()}
        title="Switch model"
      />,
    );

    expect(screen.getByLabelText("Switch model").getAttribute("title")).toBe(
      "Switch model — Ollama",
    );
  });
});

describe("ModelSelect — in-webview menu", () => {
  function openMenu(current = "claude-sonnet-5", onSelect = vi.fn()) {
    supportsNativeMock.mockReturnValue(false);
    render(
      <ModelSelect
        models={MODELS}
        currentModel={current}
        onSelect={onSelect}
        title="Switch model"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Claude Sonnet 5|gemma4/ }));
    return onSelect;
  }

  it("renders one titled section per provider, local last", () => {
    openMenu();

    const headings = Array.from(document.querySelectorAll(".model-menu-subtitle")).map(
      (el) => el.textContent,
    );
    expect(headings).toEqual(["Anthropic", "OpenAI", "xAI (Grok)", "Local"]);
    // Each section's grid is labelled for screen readers.
    expect(screen.getByRole("group", { name: "Local" })).toBeTruthy();
  });

  it("selects a model from its provider group", () => {
    const onSelect = openMenu();

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Grok 4.5" }));

    expect(onSelect).toHaveBeenCalledWith("grok-4.5");
  });

  it("refuses to select a tool-less local model", () => {
    const onSelect = openMenu();

    const item = screen.getByRole("menuitemradio", { name: "tiny (Ollama)" });
    expect(item.hasAttribute("disabled")).toBe(true);
    expect(item.getAttribute("title")).toContain("has no tool calling");

    fireEvent.click(item);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("marks the active model as checked", () => {
    openMenu("local/ollama/gemma4:e2b");

    expect(
      screen
        .getByRole("menuitemradio", { name: "gemma4:e2b (Ollama)" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });
});
