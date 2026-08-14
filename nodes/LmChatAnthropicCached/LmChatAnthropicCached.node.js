'use strict';

const { createRequire } = require('node:module');
const path = require('node:path');

const CANDIDATE_ROOTS = [
	'/usr/local/lib/node_modules/n8n/node_modules/.pnpm/@n8n+n8n-nodes-langchain@file+packages+@n8n+nodes-langchain_2c7f106572ec97ecf6e9416b33a264bd/node_modules/@n8n/n8n-nodes-langchain/package.json',
	'/usr/local/lib/node_modules/n8n/package.json',
	'/usr/lib/node_modules/n8n/package.json',
	'/home/node/node_modules/n8n/package.json',
	'/usr/local/lib/node_modules/n8n/node_modules/n8n/package.json',
];

function requireFromN8n(pkg) {
	const errors = [];
	for (const root of CANDIDATE_ROOTS) {
		try {
			return createRequire(root)(pkg);
		} catch (e) {
			errors.push(`${root}: ${e.code || e.message}`);
		}
	}
	try {
		return require(pkg);
	} catch (e) {
		errors.push(`local: ${e.code || e.message}`);
	}
	throw new Error(
		`[lmChatAnthropicCached] Could not resolve "${pkg}" from any known n8n install path.\n` +
			`Tried:\n  ${errors.join('\n  ')}\n` +
			`Fix: run \`docker exec n8n-n8n-1 sh -c "find / -name '@langchain' -type d 2>/dev/null"\` ` +
			`inside the container and add the matching package.json path to CANDIDATE_ROOTS in this file.`,
	);
}

const { ChatAnthropic } = requireFromN8n('@langchain/anthropic');

const EPHEMERAL = { type: 'ephemeral' };
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
	for (let i = message.content.length - 1; i >= 0; i--) {
		const block = message.content[i];
		if (block && typeof block === 'object' && !UNMARKABLE.has(block.type)) {
			block.cache_control = { ...EPHEMERAL };
			return true;
		}
	}
	return false;
}

function applyCacheControl(request) {
	if (!request || typeof request !== 'object') return request;

	stripMarkers(request);

	if (typeof request.system === 'string' && request.system.length > 0) {
		request.system = [{ type: 'text', text: request.system, cache_control: { ...EPHEMERAL } }];
	} else if (Array.isArray(request.system) && request.system.length > 0) {
		request.system[request.system.length - 1].cache_control = { ...EPHEMERAL };
	}

	if (Array.isArray(request.messages) && request.messages.length > 0) {
		const n = request.messages.length;
		markLastBlock(request.messages[n - 1]);
		if (n >= 2) markLastBlock(request.messages[n - 2]);
	}

	return request;
}

class ChatAnthropicCached extends ChatAnthropic {
	static lc_name() {
		return 'ChatAnthropicCached';
	}

	async completionWithRetry(request, options) {
		return super.completionWithRetry(applyCacheControl(request), options);
	}

	async createStreamWithRetry(request, options) {
		return super.createStreamWithRetry(applyCacheControl(request), options);
	}
}

class LmChatAnthropicCached {
	constructor() {
		this.description = {
			displayName: 'Anthropic Chat Model (Cached)',
			name: 'lmChatAnthropicCached',
			icon: 'file:anthropic.svg',
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
					default: 'claude-sonnet-5',
					description: 'Anthropic model ID (exact API model string)',
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
							default: 4096,
						},
						{
							displayName: 'Sampling Temperature',
							name: 'temperature',
							type: 'number',
							default: 0.7,
							typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
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
			maxTokens: options.maxTokens ?? 4096,
			
		};
		if (options.temperature !== undefined) config.temperature = options.temperature;
		if (options.baseURL) {
			config.anthropicApiUrl = options.baseURL;
		} else if (credentials.url) {
			config.anthropicApiUrl = credentials.url;
		}

		const model = new ChatAnthropicCached(config);

		return { response: model };
	}
}

module.exports = { LmChatAnthropicCached };
