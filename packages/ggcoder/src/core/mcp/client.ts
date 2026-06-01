import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { z } from "zod";
import os from "node:os";
import { log } from "../logger.js";
import type { MCPServerConfig } from "./types.js";

interface ConnectedServer {
  name: string;
  client: Client;
  transport: StreamableHTTPClientTransport | SSEClientTransport | StdioClientTransport;
  lastCallTime: number;
}

/** Per-server connection outcome for the dashboard / non-interactive list. */
export interface MCPConnectResult {
  name: string;
  ok: boolean;
  toolCount: number;
  tools: AgentTool[];
  error?: string;
}

export class MCPClientManager {
  private servers: ConnectedServer[] = [];

  async connectAll(configs: MCPServerConfig[]): Promise<AgentTool[]> {
    const results = await this.connectAllDetailed(configs);
    return results.flatMap((r) => r.tools);
  }

  /**
   * Connect every enabled server and return one result per server (success →
   * ok + toolCount; failure → ok:false with a human-readable error string).
   * Keeps successfully connected servers in `this.servers`.
   */
  async connectAllDetailed(configs: MCPServerConfig[]): Promise<MCPConnectResult[]> {
    const enabled = configs.filter((c) => c.enabled !== false);
    if (enabled.length === 0) return [];

    const settled = await Promise.allSettled(enabled.map((c) => this.connectServer(c)));

    const results: MCPConnectResult[] = settled.map((result, i) => {
      const name = enabled[i].name;
      if (result.status === "fulfilled") {
        return { name, ok: true, toolCount: result.value.length, tools: result.value };
      }
      const error = formatConnectError(result.reason);
      log("WARN", "mcp", `Failed to connect to MCP server "${name}"`, { error });
      return { name, ok: false, toolCount: 0, tools: [], error };
    });

    const connected = results.filter((r) => r.ok).length;
    const toolCount = results.reduce((sum, r) => sum + r.toolCount, 0);
    log("INFO", "mcp", `Connected ${connected} MCP server(s), ${toolCount} tool(s)`);
    return results;
  }

  /**
   * Connect a single server, list its tools, then close that client so the
   * probe connection doesn't accumulate in `this.servers`. Used to validate a
   * server before persisting it.
   */
  async probe(config: MCPServerConfig): Promise<MCPConnectResult> {
    try {
      const tools = await this.connectServer(config);
      const server = this.servers.find((s) => s.name === config.name);
      if (server) {
        this.servers = this.servers.filter((s) => s !== server);
        try {
          await server.client.close();
        } catch {
          // Ignore close errors during probe teardown.
        }
      }
      return { name: config.name, ok: true, toolCount: tools.length, tools };
    } catch (err) {
      const error = formatConnectError(err);
      return { name: config.name, ok: false, toolCount: 0, tools: [], error };
    }
  }

  private async connectServer(config: MCPServerConfig): Promise<AgentTool[]> {
    const timeout = config.timeout ?? 30_000;
    let client: Client;
    let transport: StreamableHTTPClientTransport | SSEClientTransport | StdioClientTransport;

    if (config.command) {
      // Stdio transport for local processes.
      // cwd is forced to homedir so the user's working directory can't
      // affect resolution. e.g. running ggcoder from a folder whose
      // package.json names the same package as the MCP server makes
      // `npx -y <pkg>` self-resolve to the local source (no built bin
      // shim) and fail with "command not found".
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...process.env, ...config.env } as Record<string, string>,
        cwd: os.homedir(),
        stderr: "pipe",
      });
      // Capture stderr so a crashing server doesn't fail silently — when the
      // child closes the pipe before completing handshake, the SDK throws
      // the opaque "-32000 Connection closed" but the real cause (stack
      // trace, missing dep, port conflict) was just printed to stderr.
      const stderrChunks: string[] = [];
      transport.stderr?.on("data", (chunk: Buffer | string) => {
        stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      });
      client = new Client({ name: "ggcoder", version: "1.0.0" });
      try {
        await client.connect(transport, { timeout });
      } catch (err) {
        const stderr = stderrChunks.join("").slice(-4000);
        if (stderr.trim()) {
          log("WARN", "mcp", `stdio child stderr for "${config.name}"`, { stderr });
        }
        throw err;
      }
    } else {
      // HTTP transport — try StreamableHTTP first, fall back to SSE
      const url = new URL(config.url!);
      const reqInit = config.headers ? { headers: config.headers } : undefined;

      try {
        transport = new StreamableHTTPClientTransport(url, {
          requestInit: reqInit,
        });
        client = new Client({ name: "ggcoder", version: "1.0.0" });
        await client.connect(transport, { timeout });
      } catch (streamableErr) {
        log("INFO", "mcp", `StreamableHTTP failed for "${config.name}", trying SSE fallback`, {
          error: String(streamableErr),
        });
        transport = new SSEClientTransport(url, {
          eventSourceInit: config.headers
            ? { fetch: createHeaderFetch(config.headers) }
            : undefined,
          requestInit: reqInit,
        });
        client = new Client({ name: "ggcoder", version: "1.0.0" });
        await client.connect(transport, { timeout });
      }
    }

    this.servers.push({ name: config.name, client, transport, lastCallTime: 0 });

    const { tools } = await client.listTools(undefined, { timeout });

    return tools.map((tool): AgentTool => {
      const toolName = `mcp__${config.name}__${tool.name}`;
      return {
        name: toolName,
        description: tool.description ?? "",
        parameters: z.record(z.string(), z.unknown()),
        rawInputSchema: tool.inputSchema as Record<string, unknown>,
        execute: async (args) => {
          const server = this.servers.find((s) => s.name === config.name);
          if (server) {
            const elapsed = Date.now() - server.lastCallTime;
            const minGap = 2_000;
            if (elapsed < minGap) {
              await new Promise((r) => setTimeout(r, minGap - elapsed));
            }
            server.lastCallTime = Date.now();
          }

          try {
            const result = await client.callTool(
              { name: tool.name, arguments: args as Record<string, unknown> },
              undefined,
              { timeout: config.timeout ?? 60_000 },
            );
            if (!("content" in result) || !Array.isArray(result.content)) {
              return "(empty response)";
            }
            const texts: string[] = [];
            for (const item of result.content) {
              if (
                item != null &&
                typeof item === "object" &&
                "text" in item &&
                typeof item.text === "string"
              ) {
                texts.push(item.text);
              }
            }
            return texts.join("\n") || "(empty response)";
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("Too Many R") || msg.includes("429")) {
              return "Rate limited — too many requests. Wait a moment before searching again.";
            }
            return `MCP tool error: ${msg}`;
          }
        },
      };
    });
  }

  async dispose(): Promise<void> {
    for (const server of this.servers) {
      try {
        await server.client.close();
      } catch {
        // Ignore close errors
      }
    }
    this.servers = [];
  }
}

/**
 * Create a custom fetch wrapper that injects extra headers into every request.
 * Used for SSEClientTransport's eventSourceInit to pass auth headers
 * on the initial SSE GET connection (which doesn't use requestInit).
 */
/**
 * Turn a thrown connection error into a short human-readable string. Surfaces
 * the common rate-limit case explicitly; otherwise the underlying message.
 */
function formatConnectError(reason: unknown): string {
  const msg = reason instanceof Error ? reason.message : String(reason);
  if (msg.includes("Too Many R") || msg.includes("429")) {
    return "Rate limited (429) — try again in a moment.";
  }
  return msg;
}

function createHeaderFetch(extraHeaders: Record<string, string>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (url: string | URL, init: any): Promise<Response> => {
    const existing = (init?.headers ?? {}) as Record<string, string>;
    return fetch(url, { ...init, headers: { ...existing, ...extraHeaders } });
  };
}
