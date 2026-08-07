---
"@kenkaiiii/gg-ai": patch
"@kenkaiiii/gg-agent": patch
"@kenkaiiii/ggcoder": patch
---

Fix "no low surrogate in string" / Bad Request errors from Anthropic and OpenAI.

An unpaired UTF-16 surrogate anywhere in the conversation (a model streaming a
split emoji inside tool-call arguments, or a character-indexed truncation that
cut an astral character in half) made the JSON request body unparseable for
every provider — and it persisted in history, so retries and model switches
failed identically.

`stream()` now scrubs lone surrogates from all messages at the single provider
boundary, and the tool-result/shell/web-fetch/grep truncation paths cut on
character boundaries instead of splitting surrogate pairs.
