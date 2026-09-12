'use strict';
const { createHash, randomBytes } = require('node:crypto');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const processNonce = randomBytes(16).toString('hex');
const cursors = new Map(); let sequence = 0;
function semanticItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const { id, internal_chat_message_metadata_passthrough, ...rest } = item;
  return rest;
}
function guardedConversationKey(parsed, baseKey, workMode = false) {
  if (!baseKey || parsed._compactionRequest || !Array.isArray(parsed._rawBody?.input)) return undefined;
  // Work selects its exact model radio before adjusting effort on every round.
  // Retain only this same surface, model, effort, tool contract and history.
  const base = digest([baseKey, workMode, parsed.modelId, parsed.options.reasoning, parsed.context.systemPrompt, parsed.context.tools, 'lina-stream-v4']);
  const hashes = parsed._rawBody.input.map(item => digest(semanticItem(item)));
  const prior = cursors.get(base);
  const extendsHistory = prior && prior.hashes.length <= hashes.length && prior.hashes.every((hash, index) => hash === hashes[index]);
  const key = extendsHistory ? prior.key : digest([base, processNonce, ++sequence]);
  cursors.delete(base); cursors.set(base, { hashes, key });
  while (cursors.size > 64) cursors.delete(cursors.keys().next().value);
  return key;
}
function resumeRequest(parsed) {
  const lastAssistant = parsed.context.messages.findLastIndex(message => message.role === 'assistant');
  if (lastAssistant < 0 || lastAssistant === parsed.context.messages.length - 1) return undefined;
  // A retained key is bound to the identical system/tool contract and a proven
  // prefix of canonical native input. Only new messages/images need uploading.
  return { ...parsed, _linaResume: true, context: { ...parsed.context, systemPrompt: [], messages: parsed.context.messages.slice(lastAssistant + 1) } };
}
module.exports = { guardedConversationKey, resumeRequest };
