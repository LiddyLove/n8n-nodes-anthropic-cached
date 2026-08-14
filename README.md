# n8n-nodes-anthropic-cached

An **Anthropic Chat Model (Cached)** sub-node for n8n AI Agents. It injects
Anthropic prompt-caching (`cache_control`) markers on every call the agent loop
makes, so each iteration reads the accumulated transcript at cache-read prices
instead of paying full price for the whole thing again.

On the workflow this was built for — a 40-iteration agent with a long system
prompt and a dozen tools — **88% of input tokens now arrive as cache reads, and
input cost dropped about 75%** across two weeks of real traffic.

Zero dependencies. It resolves `@langchain/anthropic` from n8n's own
`node_modules`, which also guarantees the model instance passes the AI Agent's
`instanceof` checks.

---

## Why this exists

n8n's stock Anthropic Chat Model doesn't send `cache_control` markers. In a
normal chat that barely matters. In an agent loop it matters a great deal,
because every iteration resends the entire conversation so far — system prompt,
tool definitions, and every tool result to date. A 40-iteration run pays full
price for a transcript that grows on every pass.

### Why not LangChain's built-in cache_control

`@langchain/anthropic` does have `applyCacheControlToPayload`, but it isn't a
substitute:

- it's reachable only through the per-call `options.cache_control` invocation
  option, which n8n's AI Agent never sets
- it places **one** breakpoint, on the last message only
- it doesn't mark the system prompt, so the tools block isn't covered either
- it marks the last content block unconditionally, so it will put
  `cache_control` on a `thinking` block, which the API rejects

This node strips any existing markers before applying its own, so the two can't
conflict.

### Breakpoint strategy

Three of the four breakpoints Anthropic allows:

1. **System prompt** — the prefix is tools + system, so this covers the tool
   definitions too
2. **Second-to-last message** — lands where the previous call's breakpoint was,
   producing a prefix hit
3. **Last message** — extends the cache to include the newest tool result

`thinking` and `redacted_thinking` blocks are skipped, since they can't legally
carry a marker.

---

## Install

### As a community node

n8n → **Settings → Community Nodes → Install**, then enter:

```
n8n-nodes-anthropic-cached
```

This node is not in n8n's verified list, so it won't appear in the node search
panel until installed. n8n's verification guidelines exclude packages that
iterate on an existing node, which this one does.

### Manually (Docker)

Copy the package into n8n's custom-extensions directory:

```bash
docker exec <container> mkdir -p /home/node/.n8n/custom
docker cp n8n-nodes-anthropic-cached <container>:/home/node/.n8n/custom/
docker exec -u root <container> chown -R node:node /home/node/.n8n/custom
docker restart <container>
```

If your install uses a non-default custom directory, use whatever
`N8N_CUSTOM_EXTENSIONS` points to.

---

## Setup

Add the node, select your existing `anthropicApi` credential, and set **Model**
to the exact API model string (for example `claude-sonnet-5`). Then detach the
stock Anthropic Chat Model from the AI Agent's Model input and attach this one.

Keep the stock node on the canvas, disconnected, as an instant rollback.

### Set Maximum Number of Tokens. Really.

**This is the one setting people get wrong.**

`@langchain/anthropic` keeps a table of per-model output defaults. Any model
newer than the bundled build isn't in it and falls back to **4096 output
tokens** — which silently truncates tool calls partway through a `tool_use`
block. The partial block still parses, into a tool call with no name, which
then fails somewhere unrelated. At the time of writing this affects
`claude-sonnet-5`.

Set the value explicitly. **20000 is a good default.**

**The ceiling without streaming is 21,333.** The Anthropic SDK computes
`expectedTime = (60min × max_tokens) / 128000` and refuses non-streaming
requests where that exceeds ten minutes. Above 21,333 it throws. This node
checks up front and fails with an explanation, rather than letting the SDK
reject it partway through an agent run.

### Leave Sampling Temperature alone

Newer Claude models reject sampling parameters. The option is only sent if you
explicitly set it, so leaving it unset is correct for current models.

---

## What you get that the stock node doesn't

Per-call cache visibility, straight in the n8n execution UI:

```json
"tokenUsage": {
  "completionTokens": 901,
  "promptTokens": 413854,
  "totalTokens": 414755,
  "cacheReadTokens": 412425,
  "cacheWriteTokens": 1427,
  "uncachedInputTokens": 2
}
```

**A large `promptTokens` is not a sign that caching failed.** Caching changes
the *price* of input tokens, not how many are sent, so the number looks similar
either way. The stock node reports only `input_tokens`, which on a caching
setup omits nearly everything — it would show about 12 for the call above. This
node counts fresh + cache read + cache write, so the total reflects what was
actually sent, and the split beneath it shows where it came from.

The three cache fields sit outside n8n's declared `TokenUsageResult` shape. They
render on n8n 2.33; if a future release strips unknown keys they'd disappear
without affecting the three standard fields.

---

## Verifying it works

Run your workflow once, then check the Anthropic Console:

- **Cache read ratio** near 100% → working
- **Write amortization** above about 1.2× → the cache is paying for itself
- **Creation tokens on every call with reads near zero** → unstable prefix

For that last case, hunt for something dynamic early in the context: a
timestamp or execution ID templated into the system prompt, tool definitions
changing order, and so on. One changed token invalidates everything after it.

The minimum cacheable prefix is 1,024 tokens; below that the markers are
silently ignored. Cache TTL is 5 minutes, refreshed on every hit, so agent-loop
calls seconds apart stay warm.

---

## Guards

The node fails loudly rather than silently, in three places:

- **At load**, if the `@langchain/anthropic` methods it hooks have been renamed
  upstream. Without this, caching would quietly stop and every request would
  revert to full price with no error and no symptom except the bill.
- **At setup**, if Maximum Number of Tokens exceeds the non-streaming ceiling.
- **On response**, if generation stopped at the token cap. Truncated tool calls
  fail confusingly downstream; truncated prose reads as complete output. Turn
  this off with **Error on Truncated Output** if you'd rather accept partial
  responses.

---

## Known limitations

- **Not verified by n8n**, so it won't show in the node search panel until
  installed. See Install above.
- **No streaming.** This also means the 21,333 output ceiling applies.
- **No fallback model.** Leave the AI Agent's own "Enable Fallback Model"
  toggle off: it routes through LangChain's `withFallbacks()`, which returns a
  runnable with no `bindTools()`, so the agent can't attach tools to it.
- **Model is a free-text field**, not a dropdown.
- If a future n8n release adds native caching to the stock node, switch back
  and delete this.

---

## Troubleshooting

**Node doesn't appear after restart.** Check the container logs:

```bash
docker logs <container> 2>&1 | grep -i lmChatAnthropicCached
```

A resolution failure prints every path it tried.

**"Could not resolve @langchain/anthropic".** The node looks in four places:
the `N8N_CACHED_ANTHROPIC_PATH` environment variable, n8n's own module chain,
the pnpm store matched by prefix, and plain `require`. If all four fail, find
the package inside the container:

```bash
docker exec <container> sh -c "find / -type d -name anthropic -path '*@langchain*' 2>/dev/null"
```

then set `N8N_CACHED_ANTHROPIC_PATH` to the directory containing its
`package.json` and restart.

**Token counts missing from the execution UI.** The optional
`@n8n/ai-utilities` package didn't resolve. Caching still works; the logs will
carry a warning naming what was tried.

---

## License

MIT
