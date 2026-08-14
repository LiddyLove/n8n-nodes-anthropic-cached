/**
 * Package entry point.
 *
 * n8n does not load nodes through this file — it reads the `n8n.nodes` array in
 * package.json. This exists so `main` resolves to something real for npm and for
 * anyone requiring the package directly.
 */
'use strict';

module.exports = require('./nodes/LmChatAnthropicCached/LmChatAnthropicCached.node.js');
