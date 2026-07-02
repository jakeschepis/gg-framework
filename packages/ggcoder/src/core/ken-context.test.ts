import { describe, it, expect } from "vitest";
import os from "node:os";
import {
  buildKenDigest,
  buildKenAutopilotContext,
  AUTOPILOT_REVIEW_INSTRUCTION,
  KEN_RECENT_MESSAGE_LIMIT,
} from "./ken-context.js";
import { createTools } from "../tools/index.js";
import type { Message } from "@kenkaiiii/gg-ai";

// Mirror the sidecar's Ken allow-list so the filter test tracks the real set.
const KEN_ALLOWED_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "source_path",
  "web_fetch",
  "web_search",
  "screenshot",
];
const KEN_ALLOWED_MCP_SERVERS = ["kencode-search"];

// Mirror of AgentSession.isToolAllowed (which is private): a tool passes when
// its name is in the allow-list, OR it's an mcp__<server>__<tool> whose server
// is whitelisted. Kept in lockstep so this test tracks the real filter.
function isToolAllowed(name: string): boolean {
  if (KEN_ALLOWED_TOOLS.includes(name)) return true;
  if (name.startsWith("mcp__")) {
    const server = name.slice("mcp__".length).split("__")[0];
    return KEN_ALLOWED_MCP_SERVERS.includes(server);
  }
  return false;
}

describe("Ken allowedTools filter", () => {
  it("excludes every mutating tool from the Ken set", async () => {
    const { tools, processManager, lspManager } = await createTools(os.tmpdir(), {
      lspDiagnostics: false,
    });
    try {
      const kenTools = tools.filter((t) => isToolAllowed(t.name)).map((t) => t.name);

      // The mutating / orchestration tools must NOT survive the filter.
      for (const banned of ["write", "edit", "bash", "tasks", "subagent", "generate_image"]) {
        expect(kenTools).not.toContain(banned);
      }
      // The read-only research/vision tools must survive.
      for (const allowed of ["read", "grep", "find", "ls", "screenshot"]) {
        expect(kenTools).toContain(allowed);
      }
    } finally {
      processManager.shutdownAll();
      lspManager?.shutdownAll();
    }
  });

  it("allows whitelisted kencode-search MCP tools but blocks other MCP tools", () => {
    // kencode-search is Ken's research server: all its tools pass.
    expect(isToolAllowed("mcp__kencode-search__searchCode")).toBe(true);
    expect(isToolAllowed("mcp__kencode-search__referenceSources")).toBe(true);
    expect(isToolAllowed("mcp__kencode-search__discoverRepos")).toBe(true);
    // A non-whitelisted MCP server (e.g. a user-configured one) is blocked,
    // even if it exposes an innocuous-looking name.
    expect(isToolAllowed("mcp__some-other-server__searchCode")).toBe(false);
    expect(isToolAllowed("mcp__filesystem__write_file")).toBe(false);
  });
});

describe("buildKenDigest", () => {
  const base = {
    question: "what next?",
    projectContext: ["### CLAUDE.md\n\nBuild a todo app."],
    cwd: "/tmp/proj",
    gitBranch: "main" as string | null,
    platform: "darwin",
  };

  it("includes the project context, env, and the question", () => {
    const digest = buildKenDigest({ ...base, messages: [] });
    expect(digest).toContain("Build a todo app.");
    expect(digest).toContain("/tmp/proj");
    expect(digest).toContain("main");
    expect(digest).toContain("what next?");
    expect(digest).toContain("(no conversation yet)");
  });

  it("caps recent activity at the last-N messages", () => {
    const messages: Message[] = [];
    for (let i = 0; i < KEN_RECENT_MESSAGE_LIMIT + 10; i++) {
      messages.push({ role: "user", content: `msg-${i}` });
    }
    const digest = buildKenDigest({ ...base, messages });
    // The earliest messages fall outside the cap.
    expect(digest).not.toContain("msg-0");
    expect(digest).not.toContain("msg-5");
    // The newest message is kept.
    expect(digest).toContain(`msg-${KEN_RECENT_MESSAGE_LIMIT + 9}`);
  });

  it("strips image blocks from user messages", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image", mediaType: "image/png", data: "AAAABBBBCCCC" },
        ],
      },
    ];
    const digest = buildKenDigest({ ...base, messages });
    expect(digest).toContain("look at this");
    expect(digest).not.toContain("AAAABBBBCCCC");
  });

  it("buildKenAutopilotContext injects the fixed review instruction as the question", () => {
    const messages: Message[] = [
      { role: "user", content: "add a login form" },
      { role: "assistant", content: "Added the form." },
    ];
    const digest = buildKenAutopilotContext({
      projectContext: base.projectContext,
      cwd: base.cwd,
      gitBranch: base.gitBranch,
      platform: base.platform,
      messages,
    });
    // The transcript is still inlined (Ken reviews it) ...
    expect(digest).toContain("add a login form");
    expect(digest).toContain("Added the form.");
    // ... and the trailing question is the fixed autopilot instruction, not a
    // user-typed one.
    expect(digest).toContain(AUTOPILOT_REVIEW_INSTRUCTION);
    expect(digest).toContain("PROMPT");
    expect(digest).toContain("ALL_CLEAR");
    expect(digest).toContain("HUMAN");
  });

  it("uses the latest compaction summary as the story-so-far base", () => {
    const messages: Message[] = [
      { role: "user", content: "old turn that should be summarized away" },
      { role: "user", content: "[Previous conversation summary]\n\nWe scaffolded the app." },
      { role: "assistant", content: "Added the header." },
    ];
    const digest = buildKenDigest({ ...base, messages });
    expect(digest).toContain("Story so far");
    expect(digest).toContain("We scaffolded the app.");
    // Pre-summary messages are not echoed into recent activity.
    expect(digest).not.toContain("old turn that should be summarized away");
    // Post-summary activity is kept.
    expect(digest).toContain("Added the header.");
  });
});
