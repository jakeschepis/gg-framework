// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WorkspaceHeader } from "./WorkspaceHeader";

afterEach(cleanup);

function ChatHeaderHarness(): React.ReactElement {
  const [navHidden, setNavHidden] = useState(false);

  return (
    <WorkspaceHeader
      workspaceMode="chat"
      sessionTitle={null}
      navHidden={navHidden}
      onToggleNav={() => setNavHidden((hidden) => !hidden)}
    >
      <button>New chat</button>
    </WorkspaceHeader>
  );
}

describe("WorkspaceHeader", () => {
  it("renders the chevron in chat mode and toggles the navbar", () => {
    render(<ChatHeaderHarness />);

    expect(screen.getByText("GG Chat")).toBeDefined();
    expect(screen.getByRole("button", { name: "New chat" })).toBeDefined();

    const hideToggle = screen.getByRole("button", { name: "Hide nav buttons" });
    expect(hideToggle.getAttribute("aria-expanded")).toBe("true");
    expect(hideToggle.querySelector("polyline")?.getAttribute("points")).toBe("6 15 12 9 18 15");
    fireEvent.click(hideToggle);

    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
    const showToggle = screen.getByRole("button", { name: "Show nav buttons" });
    expect(showToggle.getAttribute("aria-expanded")).toBe("false");
    expect(showToggle.querySelector("polyline")?.getAttribute("points")).toBe("6 9 12 15 18 9");
    fireEvent.click(showToggle);

    expect(screen.getByRole("button", { name: "New chat" })).toBeDefined();
  });
});
