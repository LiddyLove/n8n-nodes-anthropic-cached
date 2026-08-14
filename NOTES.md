# Implementation notes

Decisions and findings that need to reach the README, and open questions that
need a real n8n instance to settle. Kept separate from the README so the README
can stay short.

## Unverified: extra token fields may not render

`tokensUsageParser` returns three fields beyond n8n's declared
`TokenUsageResult` shape:

- `cacheReadTokens`
- `cacheWriteTokens`
- `uncachedInputTokens`

n8n's type only declares `completionTokens`, `promptTokens`, `totalTokens`.
Whether the extras survive to the execution UI depends on whether n8n passes
unknown keys through or strips them, which has not been tested on a live
instance. Nothing else depends on them either way.

**Document whichever turns out to be true.** If they are dropped, say so
plainly so nobody goes hunting for a cache breakdown that never appears.

## Prompt token counts look larger than the stock node's

The stock Anthropic node's parser reads only `usage.input_tokens`. On a caching
setup that omits everything served from cache — on the reference workflow,
about 88% of input. A call that actually sent ~49,000 tokens reports as ~12.

This node counts fresh + cache read + cache write, so its prompt totals are
much larger than the stock node's for the same work.

**This is not a sign that caching failed.** Caching changes the price of input
tokens, not how many are sent, so no token count can confirm or deny that
caching is working. The Anthropic Console is the only place that can, because
it separates read / write / uncached.

Worth stating prominently in the README: the first reaction to a bigger number
is to assume the cache broke.

## Why not LangChain's built-in cache_control

`@langchain/anthropic` 1.3.27 has `applyCacheControlToPayload`, reachable via
the per-call `options.cache_control` invocation option. It is not a substitute:

- n8n's AI Agent never passes that invocation option
- One breakpoint, on the last message only
- Does not mark the system prompt, so the tools block is not covered either
- Marks the last content block unconditionally, so it would put `cache_control`
  on a `thinking` block, which the API rejects

This node strips any existing markers before applying its own, so the two
cannot conflict.

## Output token ceiling without streaming

The Anthropic SDK computes `expectedTime = (60min * max_tokens) / 128000` and
refuses non-streaming requests where that exceeds 10 minutes. Anything above
**21,333** throws. The SDK's own error names streaming as the fix but not the
number, and it surfaces mid-agent-run.

Also: models newer than the bundled `@langchain/anthropic` are absent from its
per-model default table and fall back to **4096** output tokens. At the time of
writing that includes `claude-sonnet-5`. Users must set Maximum Number of
Tokens explicitly or they get the 4096 cap silently.

## Deferred

- **Streaming.** Would lift the 21,333 ceiling, but `stop_reason` arrives as a
  stream event rather than on the returned object, so the truncation guard
  cannot fire as written. Streaming users would silently lose it. Needs testing
  against a live agent loop with tools attached, not a fixture.
- **Fallback model.** Do NOT use LangChain's `withFallbacks()` — it returns a
  `RunnableWithFallbacks` with no `bindTools()`, so the AI Agent cannot attach
  tools to it. Hand-roll try/catch inside the model class instead.
- **Model dropdown** via `loadOptions` instead of the free-text Model field.
- **Packaging**: `package.json` has `"main": "index.js"` pointing at a file that
  does not exist, and is missing `author`, `repository`, and `engines`.
