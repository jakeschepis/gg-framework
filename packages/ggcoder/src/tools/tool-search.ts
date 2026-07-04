import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { DeferredToolCatalog } from "../core/mcp/deferred-catalog.js";

const ToolSearchParams = z.object({
  query: z
    .string()
    .describe(
      "The capability you need, e.g. 'search UI design screenshots' or 'query github code'",
    ),
});

/**
 * Discovery tool for the deferred MCP catalog. Matching tools are promoted
 * into the live toolset immediately — callable from the very next turn.
 * `onPromote` pushes onto the session's live tools array (the agent loop
 * re-reads it every turn).
 */
export function createToolSearchTool(
  catalog: DeferredToolCatalog,
  onPromote: (tools: AgentTool[]) => void,
): AgentTool<typeof ToolSearchParams> {
  return {
    name: "tool_search",
    description:
      "Search the extended tool catalog (MCP servers and integrations) by capability. " +
      "Matching tools become available immediately — call them on your next step. " +
      "Use this when you need a capability not in your current toolset.",
    parameters: ToolSearchParams,
    async execute({ query }) {
      const matches = catalog.search(query);
      if (matches.length === 0) {
        const remaining = catalog.names();
        return remaining.length === 0
          ? "No tools matched and the catalog is empty — every catalog tool is already available."
          : `No tools matched "${query}". Still in the catalog: ${remaining.join(", ")}`;
      }
      const promoted = catalog.promote(matches.map((t) => t.name));
      onPromote(promoted);
      const lines = promoted.map(
        (t) => `- ${t.name}: ${t.description.split("\n")[0].slice(0, 200)}`,
      );
      return `${promoted.length} tool(s) now available:\n${lines.join("\n")}`;
    },
  };
}
