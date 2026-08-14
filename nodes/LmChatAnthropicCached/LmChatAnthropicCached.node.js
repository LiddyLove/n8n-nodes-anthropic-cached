/**
 * Anthropic Chat Model (Cached) — custom n8n sub-node
 *
 * Drop-in replacement for the stock Anthropic Chat Model sub-node that injects
 * Anthropic prompt-caching (`cache_control`) markers on every call the AI Agent
 * loop makes. Breakpoint strategy (3 of the 4 allowed):
 *   1. system prompt  (also covers the tools array, which precedes it in the prefix)
 *   2. second-to-last message  (lands where last call's breakpoint was -> prefix hit)
 *   3. last message            (extends cache to include the newest tool result)
 *
 * Resolution: @langchain/anthropic MUST come from n8n's own dependency tree, so
 * the model instance passes the AI Agent's instanceof checks. n8n ships with
 * pnpm, which does not hoist, so a plain require() will not find it. See
 * resolveAnthropic() for the strategies tried, in order.
 */
'use strict';

const { createRequire } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

const PKG = '@langchain/anthropic';

/* ------------------------------------------------------------------ */
/* Module resolution                                                   */
/* ------------------------------------------------------------------ */

// Install prefixes to probe for a pnpm store. Only used by strategy 3.
const N8N_ROOT_HINTS = [
	'/usr/local/lib/node_modules/n8n',
	'/usr/lib/node_modules/n8n',
	'/home/node/node_modules/n8n',
	'/opt/n8n',
];

function attempt(errors, label, fn) {
	try {
		const mod = fn();
		if (mod) return mod;
		errors.push(`${label}: resolved but empty`);
	} catch (e) {
		errors.push(`${label}: ${e.code || e.message}`);
	}
	return null;
}

/**
 * Strategy 1 — explicit override.
 * Set N8N_CACHED_ANTHROPIC_PATH to the directory containing the
 * @langchain/anthropic package if auto-detection fails on your install.
 */
function fromEnv(errors) {
	const p = process.env.N8N_CACHED_ANTHROPIC_PATH;
	if (!p) return null;
	return attempt(errors, `env N8N_CACHED_ANTHROPIC_PATH (${p})`, () => require(p));
}

/**
 * Strategy 2 — walk out from a module n8n has already loaded.
 * n8n depends on @n8n/n8n-nodes-langchain, which depends on @langchain/anthropic.
 * Under pnpm those are real symlinks, so resolution from that package succeeds
 * where resolution from n8n's root does not. No hardcoded version hashes.
 */
function fromN8nChain(errors, pkg = PKG) {
	const seeds = [];
	if (require.main && require.main.filename) seeds.push(require.main.filename);
	seeds.push(__filename);

	for (const seed of seeds) {
		const mod = attempt(errors, `chain via ${seed}`, () => {
			const r = createRequire(seed);
			// Prefer package.json (stable path); fall back to the entry point,
			// since some packages restrict "exports" and hide package.json.
			let anchor;
			try {
				anchor = r.resolve('@n8n/n8n-nodes-langchain/package.json');
			} catch {
				anchor = r.resolve('@n8n/n8n-nodes-langchain');
			}
			return createRequire(anchor)(pkg);
		});
		if (mod) return mod;
	}
	return null;
}

/**
 * Strategy 3 — scan the pnpm store by prefix.
 * Directory names look like:
 *   @langchain+anthropic@1.3.27_@langchain+core@1.2.0_..._<hash>
 * We match on the prefix and ignore the version and hash entirely, so this
 * survives n8n upgrades that the old hardcoded-path approach did not.
 */
function fromPnpmStore(errors, pkg = PKG, prefix = '@langchain+anthropic@') {
	const stores = [];
	for (const base of N8N_ROOT_HINTS) {
		const store = path.join(base, 'node_modules', '.pnpm');
		if (fs.existsSync(store)) stores.push(store);
	}
	if (stores.length === 0) {
		errors.push('pnpm store: no .pnpm directory found under any known n8n root');
		return null;
	}

	for (const store of stores) {
		let entries;
		try {
			entries = fs.readdirSync(store);
		} catch (e) {
			errors.push(`pnpm store ${store}: ${e.code || e.message}`);
			continue;
		}
		// Newest-looking first, so a multi-version install prefers the higher one.
		const matches = entries.filter((d) => d.startsWith(prefix)).sort().reverse();
		if (matches.length === 0) {
			errors.push(`pnpm store ${store}: no ${prefix}* entry`);
			continue;
		}
		for (const dir of matches) {
			const target = path.join(store, dir, 'node_modules', pkg);
			const mod = attempt(errors, `pnpm ${dir}`, () => require(target));
			if (mod) return mod;
		}
	}
	return null;
}

/** Strategy 4 — plain resolution. Works only on npm-based, hoisted installs. */
function fromPlainRequire(errors) {
	return attempt(errors, 'plain require', () => require(PKG));
}

function resolveAnthropic() {
	const errors = [];
	const mod =
		fromEnv(errors) || fromN8nChain(errors) || fromPnpmStore(errors) || fromPlainRequire(errors);

	if (mod) return mod;

	throw new Error(
		`[lmChatAnthropicCached] Could not resolve "${PKG}" from n8n's dependency tree.\n` +
			`Tried:\n  ${errors.join('\n  ')}\n\n` +
			`Fix: locate the package inside the n8n container:\n` +
			`  docker exec <container> sh -c "find / -type d -name anthropic -path '*@langchain*' 2>/dev/null"\n` +
			`then set N8N_CACHED_ANTHROPIC_PATH to the directory that contains its package.json ` +
			`and restart the container.`,
	);
}

const { ChatAnthropic } = resolveAnthropic();

if (typeof ChatAnthropic !== 'function') {
	throw new Error(
		`[lmChatAnthropicCached] Resolved "${PKG}" but it does not export ChatAnthropic. ` +
			`The installed version is incompatible with this node.`,
	);
}

/**
 * Fail loudly if the methods we hook have been renamed upstream.
 * Without this the subclass silently stops injecting cache_control and every
 * request quietly reverts to full price — a failure with no error and no
 * symptom except the bill.
 */
const HOOKED_METHODS = ['completionWithRetry', 'createStreamWithRetry'];
for (const method of HOOKED_METHODS) {
	if (typeof ChatAnthropic.prototype[method] !== 'function') {
		throw new Error(
			`[lmChatAnthropicCached] ChatAnthropic.prototype.${method} is missing in the installed ` +
				`${PKG}. This node injects prompt caching by overriding it, so caching would silently ` +
				`stop working. Refusing to load rather than charge you full price without warning. ` +
				`Check for an updated version of this node.`,
		);
	}
}

/* ------------------------------------------------------------------ */
/* Optional: n8n's own LLM helpers                                     */
/* ------------------------------------------------------------------ */

/**
 * N8nLlmTracing is what puts token counts and generations into the execution
 * UI for the stock model sub-nodes; makeN8nLlmFailedAttemptHandler surfaces
 * retry failures as proper n8n errors. Both live in @n8n/ai-utilities.
 *
 * This is strictly optional. Caching is the point of this node and works
 * without it, so a resolution failure degrades to "no token counts in the UI"
 * rather than refusing to load. The reason is recorded for the log.
 */
const AI_UTILITIES = (() => {
	const errors = [];
	const mod =
		fromN8nChain(errors, '@n8n/ai-utilities') ||
		fromPnpmStore(errors, '@n8n/ai-utilities', '@n8n+ai-utilities@') ||
		attempt(errors, 'plain require', () => require('@n8n/ai-utilities'));

	if (!mod || typeof mod.N8nLlmTracing !== 'function') {
		console.warn(
			`[lmChatAnthropicCached] Optional @n8n/ai-utilities not resolved; the node works ` +
				`but token counts will not appear in the n8n execution UI. Tried: ${errors.join(' | ')}`,
		);
		return null;
	}
	return mod;
})();

/**
 * Anthropic reports cached input separately from fresh input. The stock node's
 * parser reads only `input_tokens`, so on a caching setup it under-reports
 * prompt tokens by whatever came from cache — which here is most of them.
 * Counting all three gives a prompt total that matches what was actually sent.
 */
function tokensUsageParser(result) {
	const usage = (result && result.llmOutput && result.llmOutput.usage) || {};
	const fresh = usage.input_tokens || 0;
	const cacheRead = usage.cache_read_input_tokens || 0;
	const cacheWrite = usage.cache_creation_input_tokens || 0;
	const promptTokens = fresh + cacheRead + cacheWrite;
	const completionTokens = usage.output_tokens || 0;
	return {
		completionTokens,
		promptTokens,
		totalTokens: promptTokens + completionTokens,
		// Beyond n8n's declared TokenUsageResult shape. If the UI passes unknown
		// keys through, these show the cache split where you are already looking;
		// if it drops them, nothing above is affected. Either way the Anthropic
		// Console remains the authoritative source.
		cacheReadTokens: cacheRead,
		cacheWriteTokens: cacheWrite,
		uncachedInputTokens: fresh,
	};
}

/* ------------------------------------------------------------------ */
/* cache_control injection                                             */
/* ------------------------------------------------------------------ */

/**
 * The Anthropic SDK refuses non-streaming requests it estimates could exceed its
 * 10-minute timeout. From client.calculateNonstreamingTimeout():
 *
 *   expectedTime = (60min * max_tokens) / 128000
 *   throw if expectedTime > 10min
 *
 * Solving for max_tokens: anything above 21,333 throws. The SDK's error names
 * streaming as the fix but not the number, and it surfaces mid-agent-run, so we
 * check up front instead.
 */
const NONSTREAMING_MAX_TOKENS = 21333;

const EPHEMERAL = { type: 'ephemeral' };

// Content-block types that may NOT carry cache_control.
const UNMARKABLE = new Set(['thinking', 'redacted_thinking']);

function stripMarkers(request) {
	if (Array.isArray(request.system)) {
		for (const b of request.system) delete b.cache_control;
	}
	if (Array.isArray(request.tools)) {
		for (const t of request.tools) delete t.cache_control;
	}
	if (Array.isArray(request.messages)) {
		for (const m of request.messages) {
			if (Array.isArray(m.content)) {
				for (const b of m.content) {
					if (b && typeof b === 'object') delete b.cache_control;
				}
			}
		}
	}
}

function markLastBlock(message) {
	if (message == null) return false;
	if (typeof message.content === 'string') {
		if (message.content.length === 0) return false;
		message.content = [{ type: 'text', text: message.content }];
	}
	if (!Array.isArray(message.content) || message.content.length === 0) return false;
	// Walk backwards to find the last block that can legally carry cache_control.
	for (let i = message.content.length - 1; i >= 0; i--) {
		const block = message.content[i];
		if (block && typeof block === 'object' && !UNMARKABLE.has(block.type)) {
			block.cache_control = { ...EPHEMERAL };
			return true;
		}
	}
	return false;
}

/**
 * Mutates an Anthropic Messages API request payload in place, then returns it.
 */
function applyCacheControl(request) {
	if (!request || typeof request !== 'object') return request;

	// Idempotency: never stack markers across retries / prior wrapping.
	stripMarkers(request);

	// Breakpoint 1: system prompt (prefix = tools + system, so this covers tools too).
	if (typeof request.system === 'string' && request.system.length > 0) {
		request.system = [{ type: 'text', text: request.system, cache_control: { ...EPHEMERAL } }];
	} else if (Array.isArray(request.system) && request.system.length > 0) {
		request.system[request.system.length - 1].cache_control = { ...EPHEMERAL };
	}

	// Breakpoints 2 + 3: last and second-to-last messages.
	if (Array.isArray(request.messages) && request.messages.length > 0) {
		const n = request.messages.length;
		markLastBlock(request.messages[n - 1]);
		if (n >= 2) markLastBlock(request.messages[n - 2]);
	}

	return request;
}

/**
 * Detect a response that hit the output cap.
 *
 * When generation stops at max_tokens partway through a tool_use block, the
 * partial block still parses — into a tool call with no name and no arguments,
 * which then fails somewhere downstream with an error that points nowhere near
 * the real cause. Truncated prose is less dramatic but produces half-written
 * output that reads as complete.
 *
 * Both get thrown here, where the cause is still legible.
 */
function assertNotTruncated(response, request) {
	if (!response || response.stop_reason !== 'max_tokens') return;

	const cap = request && request.max_tokens;
	const truncatedToolUse =
		Array.isArray(response.content) && response.content.some((b) => b && b.type === 'tool_use');

	const detail = truncatedToolUse
		? 'Generation was cut off partway through a tool call, which would surface later as a tool call with no name.'
		: 'The response was cut off mid-output and is incomplete.';

	throw new Error(
		`[lmChatAnthropicCached] Response hit the output token cap` +
			(cap ? ` (max_tokens: ${cap})` : '') +
			`. ${detail} Raise "Maximum Number of Tokens" on the model node ` +
			`(ceiling is ${NONSTREAMING_MAX_TOKENS} without streaming), or shorten what the agent ` +
			`is being asked to produce in one turn.`,
	);
}

/* ------------------------------------------------------------------ */
/* Model subclass                                                      */
/* ------------------------------------------------------------------ */

class ChatAnthropicCached extends ChatAnthropic {
	static lc_name() {
		return 'ChatAnthropicCached';
	}

	async completionWithRetry(request, options) {
		const response = await super.completionWithRetry(applyCacheControl(request), options);
		if (this.errorOnTruncation !== false) assertNotTruncated(response, request);
		return response;
	}

	// No truncation check here: streaming delivers stop_reason as a later event
	// rather than on the returned object, so there is nothing to inspect at this
	// point. Streaming is also exempt from the SDK's non-streaming token ceiling.
	async createStreamWithRetry(request, options) {
		return super.createStreamWithRetry(applyCacheControl(request), options);
	}
}

/* ------------------------------------------------------------------ */
/* n8n node                                                            */
/* ------------------------------------------------------------------ */

class LmChatAnthropicCached {
	constructor() {
		this.description = {
			displayName: 'Anthropic Chat Model (Cached)',
			name: 'lmChatAnthropicCached',
			icon: 'fa:robot',
			group: ['transform'],
			version: 1,
			description:
				'Anthropic chat model with prompt caching (cache_control) injected on every agent-loop call',
			defaults: { name: 'Anthropic Chat Model (Cached)' },
			codex: {
				categories: ['AI'],
				subcategories: { AI: ['Language Models'] },
			},
			inputs: [],
			outputs: ['ai_languageModel'],
			outputNames: ['Model'],
			credentials: [{ name: 'anthropicApi', required: true }],
			properties: [
				{
					displayName: 'Model',
					name: 'model',
					type: 'string',
					default: 'claude-sonnet-4-6',
					description: 'Anthropic model ID (exact API model string)',
				},
				{
					displayName:
						'Set Maximum Number of Tokens below. Models newer than the bundled LangChain build fall back to a 4096 output cap, which truncates tool calls mid-block. Without streaming the ceiling is 21333.',
					name: 'maxTokensNotice',
					type: 'notice',
					default: '',
				},
				{
					displayName: 'Options',
					name: 'options',
					type: 'collection',
					placeholder: 'Add Option',
					default: {},
					options: [
						{
							displayName: 'Maximum Number of Tokens',
							name: 'maxTokens',
							type: 'number',
							default: 16384,
							description:
								'Leave unset to use the per-model default. Setting this too low truncates tool calls mid-block.',
						},
						{
							displayName: 'Sampling Temperature',
							name: 'temperature',
							type: 'number',
							default: 0.7,
							typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
							description:
								'Leave unset on newer models — some reject sampling parameters entirely',
						},
						{
							displayName: 'Error on Truncated Output',
							name: 'errorOnTruncation',
							type: 'boolean',
							default: true,
							description:
								'Whether to throw when a response stops at the token cap. On by default because a truncated tool call otherwise surfaces as a nameless tool call, and truncated prose reads as complete output. Turn off to accept partial responses.',
						},
						{
							displayName: 'Base URL',
							name: 'baseURL',
							type: 'string',
							default: '',
							description: 'Override the Anthropic API base URL (leave empty for default)',
						},
					],
				},
			],
		};
	}

	async supplyData(itemIndex) {
		const credentials = await this.getCredentials('anthropicApi');
		const modelName = this.getNodeParameter('model', itemIndex);
		const options = this.getNodeParameter('options', itemIndex, {});

		const config = {
			apiKey: credentials.apiKey,
			model: modelName,
		};

		// Only set maxTokens when the user explicitly chose one. Passing a value
		// unconditionally overrides @langchain/anthropic's per-model default table
		// (16384 for current models), silently capping output and truncating tool
		// calls mid-block.
		if (options.maxTokens !== undefined && options.maxTokens !== null) {
			config.maxTokens = options.maxTokens;
		}

		// Fail here rather than partway through an agent run. The SDK raises this
		// on the first request, by which point the agent has already burned
		// iterations and the error reads as a generic streaming complaint.
		if (!config.streaming && config.maxTokens > NONSTREAMING_MAX_TOKENS) {
			throw new Error(
				`[lmChatAnthropicCached] Maximum Number of Tokens is ${config.maxTokens}, above the ` +
					`${NONSTREAMING_MAX_TOKENS} ceiling the Anthropic SDK allows without streaming. ` +
					`It derives this from (60min x max_tokens) / 128000 > 10min and rejects the request ` +
					`outright. Lower the value to ${NONSTREAMING_MAX_TOKENS} or below.`,
			);
		}

		// Same reasoning: newer models reject sampling params outright.
		if (options.temperature !== undefined) config.temperature = options.temperature;

		if (options.baseURL) {
			config.anthropicApiUrl = options.baseURL;
		} else if (credentials.url) {
			config.anthropicApiUrl = credentials.url;
		}

		// Attach n8n's tracing so the execution UI shows generations and token
		// counts, matching the stock node. Skipped silently if the optional
		// helper package could not be resolved.
		if (AI_UTILITIES) {
			config.callbacks = [new AI_UTILITIES.N8nLlmTracing(this, { tokensUsageParser })];
			if (typeof AI_UTILITIES.makeN8nLlmFailedAttemptHandler === 'function') {
				config.onFailedAttempt = AI_UTILITIES.makeN8nLlmFailedAttemptHandler(this);
			}
		}

		const model = new ChatAnthropicCached(config);

		// Set after construction: ChatAnthropic's constructor would drop an
		// unrecognised field, and this is ours rather than LangChain's.
		model.errorOnTruncation = options.errorOnTruncation !== false;

		return { response: model };
	}
}

module.exports = { LmChatAnthropicCached };
