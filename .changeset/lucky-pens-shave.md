---
"@kenkaiiii/gg-agent": patch
"@kenkaiiii/ggcoder": patch
---

Compaction now uses the shared strict-adjacency tool pairing repair.

`compactor.ts` had a divergent, pre-fix copy of the tool_call/tool_result
invariant: it matched ids globally across the conversation instead of requiring
strict adjacency, and it repaired a missing result by **stripping the assistant's
tool_call block** (sometimes leaving `content = ""`). That erased the record that
the agent ran a tool from the persisted compacted history.

It now calls `repairToolPairingAdjacent` from `@kenkaiiii/gg-agent` (newly
exported from the barrel), which preserves the tool_call and closes it with a
synthetic `"Tool execution was interrupted."` result, dedups already-answered
ids, and merges consecutive tool messages. One implementation, no more drift.
