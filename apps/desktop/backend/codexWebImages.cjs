'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const imageTypes = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
function validImage(bytes, type) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > 20000000) return false;
  if (type === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (type === 'image/webp') return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  return false;
}
function imageSourceAllowed(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && (url.hostname === 'chatgpt.com' || url.hostname === 'files.oaiusercontent.com' || url.hostname.endsWith('.oaiusercontent.com')); } catch { return false; }
}
function imageToolResult(image) {
  // The embedded native TUI serializes MCP image content into its transcript.
  // Keep the full image on disk; view_image can inspect it when a task needs it.
  return { content: [{ type: 'text', text: `Saved image:\n${path.basename(image.file)}\n${image.width} x ${image.height}\nLocation: ${image.file}\nClick the image filename in Lina to open it.\nIf this image belongs in a project or a destination was requested, use native file tools to copy it there before finishing. Preserve this original and avoid overwriting unrelated assets.` }] };
}
const inputTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
function imageIdentity(src) { try { const url = new URL(src); return url.searchParams.get('id') || url.searchParams.get('file_id') || src; } catch { return src; } }
function generatedCandidate(images, excluded = new Set()) {
  const references = new Set([...excluded, ...images.filter(image => image.reference).map(image => imageIdentity(image.src))]);
  return images.findLast(image => !image.reference && !references.has(imageIdentity(image.src)) && imageSourceAllowed(image.src));
}
function imageDiagnostic(stage, fields) {
  try {
    const directory = path.join(process.env.CODEX_CHATGPT_WEB_HOME, 'logs'), file = path.join(directory, 'lina-images.jsonl'); fs.mkdirSync(directory, { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 1048576) { if (fs.existsSync(file + '.1')) fs.unlinkSync(file + '.1'); fs.renameSync(file, file + '.1'); }
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), stage, ...fields }) + '\n', { mode: 0o600 });
  } catch {}
}
async function stopImagePage(page) {
  if (!page) return;
  const stop = page.locator('button[data-testid="stop-button"]').last();
  if (await stop.isVisible().catch(() => false)) await stop.click({ timeout: 1000 }).catch(() => {});
}
function readImageReferences(paths) {
  if (!Array.isArray(paths) || paths.length > 10) throw Object.assign(new Error('At most ten images can be attached.'), { code: 'image_input_limit' });
  let total = 0;
  return paths.map((value, index) => {
    if (typeof value !== 'string' || !path.isAbsolute(value) || /^\\\\/.test(value)) throw Object.assign(new Error('Images require a local absolute path.'), { code: 'image_input_invalid' });
    let file, bytes, type;
    try {
      file = fs.realpathSync(value); type = inputTypes[path.extname(file).toLowerCase()];
      const stat = fs.statSync(file);
      if (!stat.isFile() || !type || /^\\\\/.test(file)) throw new Error('Unsupported image');
      if (stat.size > 20000000 || (total += stat.size) > 50000000) throw Object.assign(new Error('Image attachment size limit exceeded.'), { code: 'image_input_limit' });
      bytes = fs.readFileSync(file);
      if (!(type === 'image/gif' ? /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6)) : validImage(bytes, type))) throw new Error('Invalid image');
    } catch (error) { if (error.code === 'image_input_limit') throw error; throw Object.assign(new Error('The image file is missing or unsupported.'), { code: 'image_input_invalid' }); }
    return { file, name: `reference-${index + 1}` + path.extname(file).toLowerCase(), mimeType: type, buffer: bytes };
  });
}
function clipboardImagePath(directory, clipboard) {
  const image = clipboard?.readImage();
  if (!image || image.isEmpty()) return [];
  const bytes = image.toPNG();
  if (!validImage(bytes, 'image/png')) throw Object.assign(new Error('Clipboard image exceeds the supported size.'), { code: 'image_input_limit' });
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'clipboard-' + crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 20) + '.png');
  if (!fs.existsSync(file)) fs.writeFileSync(file, bytes, { mode: 0o600 });
  return [file];
}
function resolveGeneratedImage(directory, filename) {
  if (typeof filename !== 'string' || !/^image-[a-f0-9]{20}\.(?:png|jpg|webp)$/.test(filename)) throw new Error('image_unavailable');
  try {
    const root = fs.realpathSync(directory), file = fs.realpathSync(path.join(root, filename));
    const normalized = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (normalized(path.dirname(file)) !== normalized(root) || fs.statSync(file).size > 20000000) throw new Error('image_unavailable');
    const bytes = fs.readFileSync(file), type = Object.keys(imageTypes).find(type => imageTypes[type] === path.extname(filename).slice(1));
    if (!validImage(bytes, type)) throw new Error('image_unavailable');
    return file;
  } catch { throw new Error('image_unavailable'); }
}
async function generateImage(api, prompt, abortSignal, referencedImagePaths = []) {
  if (abortSignal?.aborted) throw new DOMException('Image generation cancelled', 'AbortError');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12000) throw Object.assign(new Error('Invalid image prompt'), { code: 'invalid_prompt' });
  const references = readImageReferences(referencedImagePaths);
  const started = Date.now(); imageDiagnostic('started', { references: references.length });
  const config = api.loadConfig(), descriptorPath = config.browserHostDescriptorPath;
  const validation = await api.waitForValidation(api.readLauncherBrowserHostDescriptor(descriptorPath), abortSignal);
  if (!validation.ok) throw Object.assign(new Error(validation.message), { code: validation.code });
  const models = api.readAccountCatalog().models;
  const model = models.find(item => /instant$/.test(item.slug) && !item.workMode);
  if (!model) throw Object.assign(new Error('No image-capable Web model is available'), { code: 'image_model_unavailable' });
  const traceId = 'image_' + crypto.randomBytes(16).toString('hex');
  const owner = { traceId, helperPid: process.pid }; let connection, completed = false, heartbeat, page, cancelling;
  const abort = () => { cancelling ||= (async () => { await stopImagePage(page); await connection?.browser.close().catch(() => {}); })(); };
  try {
    const lease = await api.notifyLauncherTurn(descriptorPath, { ...owner, phase: 'start' });
    heartbeat = setInterval(() => { void api.notifyLauncherTurn(descriptorPath, { ...owner, phase: 'heartbeat' }).catch(() => {}); }, 10000);
    connection = await api.connectLauncherBrowserHost(descriptorPath, 20000, lease.surfaceId, abortSignal);
    abortSignal?.addEventListener('abort', abort, { once: true });
    if (abortSignal?.aborted) throw new DOMException('Image generation cancelled', 'AbortError');
    page = connection.page;
    await page.setViewportSize({ width: 1280, height: 900 });
    // Image creation is unavailable in this account's Temporary Chat mode.
    // This dedicated regular chat receives only the requested image prompt.
    await page.goto('https://chatgpt.com/?model=' + encodeURIComponent(model.slug), { waitUntil: 'domcontentloaded', timeout: 30000 });
    const composer = page.locator('#prompt-textarea,[data-testid="prompt-textarea"]').filter({ visible: true }).last();
    await composer.waitFor({ state: 'visible', timeout: 20000 });
    const outputs = page.locator('main img');
    const prior = new Set((await outputs.evaluateAll(nodes => nodes.map(img => img.currentSrc || img.src))).map(imageIdentity));
    await composer.fill('Use ChatGPT image generation to create one image for this request. Do not substitute code or SVG.' + (references.length ? ' Use the attached reference images in their numbered order. For an edit, preserve everything the request does not ask to change.' : '') + '\n\n' + prompt.trim());
    if (references.length) {
      const input = page.locator('input[data-testid="upload-photos-input"]');
      await input.waitFor({ state: 'attached', timeout: 20000 });
      await input.setInputFiles(references.map(({ name, mimeType, buffer }) => ({ name, mimeType, buffer })));
      const form = composer.locator('xpath=ancestor::form[1]');
      await Promise.all(references.map(file => form.getByRole('group', { name: file.name, exact: true }).waitFor({ state: 'visible', timeout: 60000 })));
      const readyBy = Date.now() + 60000;
      while (!await form.getByTestId('send-button').isEnabled()) { if (Date.now() > readyBy) throw Object.assign(new Error('Image upload failed'), { code: 'image_input_failed' }); if (abortSignal?.aborted) throw new DOMException('Image generation cancelled', 'AbortError'); await pause(100); }
    }
    if (abortSignal?.aborted) throw new DOMException('Image generation cancelled', 'AbortError');
    await page.locator('button[data-testid="send-button"]').click();
    imageDiagnostic('submitted', { elapsedMs: Date.now() - started, references: references.length });
    const deadline = Date.now() + 240000; let previous = '', stable = 0;
    while (Date.now() < deadline) {
      if (abortSignal?.aborted) throw new DOMException('Image generation cancelled', 'AbortError');
      const images = await outputs.evaluateAll(nodes => nodes.filter(img => img.complete && img.naturalWidth >= 256 && img.naturalHeight >= 256 && img.getBoundingClientRect().width >= 128).map(img => ({ src: img.currentSrc || img.src, width: img.naturalWidth, height: img.naturalHeight, reference: !!img.closest('[data-message-author-role="user"],form') })));
      const latest = generatedCandidate(images, prior);
      const running = await page.locator('button[data-testid="stop-button"]').isVisible().catch(() => false);
      if (latest && !running) { stable = latest.src === previous ? stable + 1 : 1; previous = latest.src; } else stable = 0;
      if (latest && stable >= 3) {
        const downloaded = await page.evaluate(async url => {
          const session = await fetch('/api/auth/session', { credentials: 'include' }).then(response => response.json());
          const response = await fetch(url, { credentials: 'include', redirect: 'error', headers: new URL(url).origin === location.origin ? { Authorization: 'Bearer ' + session.accessToken } : {} });
          if (!response.ok) return { status: response.status };
          const type = response.headers.get('content-type')?.split(';')[0];
          if (Number(response.headers.get('content-length')) > 20000000) { await response.body?.cancel(); return { status: 413 }; }
          const reader = response.body.getReader(), chunks = []; let size = 0;
          while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 20000000) { await reader.cancel(); return { status: 413 }; } chunks.push(value); }
          const bytes = new Uint8Array(size); let cursor = 0;
          for (const chunk of chunks) { bytes.set(chunk, cursor); cursor += chunk.length; }
          let binary = '';
          for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
          return { status: 200, type, data: btoa(binary) };
        }, latest.src);
        if (abortSignal?.aborted) throw new DOMException('Image generation cancelled', 'AbortError');
        if (downloaded.status !== 200 || !Object.hasOwn(imageTypes, downloaded.type)) throw Object.assign(new Error('Image download failed'), { code: downloaded.status === 401 ? 'chatgpt_session_expired' : 'image_download_failed' });
        const bytes = Buffer.from(downloaded.data, 'base64');
        if (!validImage(bytes, downloaded.type)) throw Object.assign(new Error('Invalid image download'), { code: 'image_download_failed' });
        const directory = path.join(path.dirname(process.env.CODEX_HOME), 'generated-images'); fs.mkdirSync(directory, { recursive: true });
        const filename = 'image-' + crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 20) + '.' + imageTypes[downloaded.type];
        const file = path.join(directory, filename), pending = file + '.' + process.pid + '.tmp';
        fs.writeFileSync(pending, bytes, { mode: 0o600 }); fs.renameSync(pending, file);
        completed = true;
        imageDiagnostic('saved', { elapsedMs: Date.now() - started, bytes: bytes.length, references: references.length });
        return { file, mimeType: downloaded.type, width: latest.width, height: latest.height };
      }
      await pause(1000);
    }
    throw Object.assign(new Error('Image generation timed out'), { code: 'image_timeout' });
  } finally {
    if (!completed) imageDiagnostic('failed', { elapsedMs: Date.now() - started, cancelled: abortSignal?.aborted === true });
    clearInterval(heartbeat); abortSignal?.removeEventListener('abort', abort);
    await cancelling;
    await connection?.browser.close().catch(() => {});
    await api.notifyLauncherTurn(descriptorPath, { ...owner, phase: 'end', status: completed ? 'completed' : 'aborted' }).catch(() => {});
  }
}
async function runImageToolServer(api, options = {}) {
  const active = new Map(), pending = new Set(), input = readline.createInterface({ input: options.input || process.stdin });
  let open = true;
  const send = value => { if (open) (options.output || process.stdout).write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n'); };
  const cancelAll = () => { for (const controller of active.values()) controller.abort(); };
  const onInterrupt = () => { imageDiagnostic('cancelled_signal', { active: active.size }); cancelAll(); };
  const onTerminate = () => { cancelAll(); input.close(); };
  if (!options.input) { process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate); }
  input.on('line', line => { const job = (async () => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.method === 'notifications/cancelled') { imageDiagnostic('cancelled_notification', { matched: active.has(message.params?.requestId) }); active.get(message.params?.requestId)?.abort(); return; }
    if (message.id === undefined) return;
    if (message.method === 'initialize') return send({ id: message.id, result: { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'lina-codex-web-images', version: '1.0.0' } } });
    if (message.method === 'ping') return send({ id: message.id, result: {} });
    if (message.method === 'tools/list') return send({ id: message.id, result: { tools: [{ name: 'generate_image', description: 'Generate or edit one picture using this Codex Web account and save it locally. For edits or visual references, supply referenced_image_paths in the same order used in the prompt; inspect local references with native view_image first. Uses a separate regular ChatGPT image chat, so the prompt, supplied reference images and result may appear in Web history. The workspace conversation is not sent. Returns filename, path and dimensions. If the result belongs in a project, copy it into the intended project location with native file tools before finishing, preserving the original. For a standalone picture, include the bare generated filename so the user can click it in Lina. Image bytes are not automatically returned to the model.', inputSchema: { type: 'object', properties: { prompt: { type: 'string', description: 'Describe the image or edits, and the role of each supplied reference.' }, referenced_image_paths: { type: 'array', maxItems: 10, items: { type: 'string' }, description: 'Optional absolute local PNG/JPEG/GIF/WebP image paths. At most 20 MB each and 50 MB combined. Required for editing an existing image or using actual visual references.' } }, required: ['prompt'], additionalProperties: false } }] } });
    if (message.method !== 'tools/call' || message.params?.name !== 'generate_image') return send({ id: message.id, error: { code: -32601, message: 'Unknown image tool method' } });
    const controller = new AbortController(); active.set(message.id, controller); let releaseNative;
    try {
      releaseNative = await api.watchNativeAbort?.(process.env.CODEX_HOME, message.params._meta, controller);
      const image = await (options.generate || generateImage)(api, message.params.arguments?.prompt, controller.signal, message.params.arguments?.referenced_image_paths);
      if (controller.signal.aborted) throw new DOMException('Image generation cancelled', 'AbortError');
      send({ id: message.id, result: imageToolResult(image) });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const code = ['chatgpt_session_expired', 'web_account_changed', 'image_model_unavailable', 'image_download_failed', 'image_timeout', 'invalid_prompt', 'image_input_invalid', 'image_input_limit', 'image_input_failed', 'image_cancellation_unavailable'].includes(error.code) ? error.code : 'image_generation_failed';
      const messages = { image_input_invalid: 'A reference image is missing or unsupported. Use an absolute local PNG/JPEG/GIF/WebP path.', image_input_limit: 'Use at most ten reference images, no larger than 20 MB each or 50 MB combined.', image_input_failed: 'ChatGPT could not finish uploading the reference images. Check the connection and retry.', image_timeout: 'Timed out waiting for an image output. Check the image chat in ChatGPT before retrying; an image may already exist there. This timeout does not establish that the login expired.', image_download_failed: 'ChatGPT produced an image, but its download could not be saved. Check the connection and image chat before retrying.', chatgpt_session_expired: 'Your ChatGPT sign-in expired. Use the Codex Web pane menu to sign in again.', web_account_changed: 'The Web account changed. Use the pane menu to sign in and reload its models.', image_model_unavailable: 'This Web account does not expose a supported image-generation model.' };
      messages.image_cancellation_unavailable = 'The image operation could not bind to this native session for cancellation. Restart a normal saved Codex Web session; image generation is unavailable with --ephemeral.';
      send({ id: message.id, result: { isError: true, content: [{ type: 'text', text: cancelled ? 'Image generation cancelled.' : (messages[code] || `Could not complete image generation (${code}). Check the connection and Codex Web image diagnostics.`) + ' The request was not automatically repeated.' }] } });
    } finally { releaseNative?.(); active.delete(message.id); }
  })().catch(() => {}); pending.add(job); void job.finally(() => pending.delete(job)); });
  await new Promise(resolve => input.once('close', resolve)); open = false;
  imageDiagnostic('client_closed', { active: active.size }); cancelAll();
  await Promise.allSettled([...pending]);
  if (!options.input) { process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate); }
}
module.exports = { generateImage, runImageToolServer, imageSourceAllowed, validImage, imageToolResult, resolveGeneratedImage, readImageReferences, clipboardImagePath, generatedCandidate, stopImagePage };
