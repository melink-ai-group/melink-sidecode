import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildOpencodeConfig } from './config.ts';
import { buildZenOpencodeConfig } from './zenConfig.ts';
import { UNKNOWN_CAPABILITIES, ollamaCapabilities } from '../capabilities.ts';
import { opencodeAttachmentConfig, opencodeV1Parts, opencodeV2Prompt, prepareOpencodeAttachments, OPENCODE_ATTACHMENT_BYTES } from './attachments.ts';

const inline = { id: 'image', name: 'paste.png', kind: 'image' as const, mimeType: 'image/png', dataUrl: 'data:image/png;base64,Ynl0ZXM=' };

test('clipboard bytes become native v1 file parts and v2 file references, alongside the prompt', async () => {
  const files = await prepareOpencodeAttachments([inline]);
  assert.deepEqual(opencodeV1Parts('inspect image', files), [{ type: 'text', text: 'inspect image' },
    { type: 'file', url: inline.dataUrl, filename: 'paste.png', mime: 'image/png' }]);
  assert.deepEqual(opencodeV2Prompt('inspect image', files), { text: 'inspect image', files: [{ uri: inline.dataUrl, name: 'paste.png' }] });
  assert.deepEqual(opencodeV2Prompt('no files'), { text: 'no files' });
});

test('picked files use encoded absolute file URIs and unreadable or relative files fail explicitly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sidecode-attachments-'));
  const path = join(dir, 'notes #1.txt');
  try {
    await writeFile(path, 'the requested file');
    const files = await prepareOpencodeAttachments([{ id: 'text', name: 'notes #1.txt', mimeType: 'text/plain', kind: 'text', path }]);
    assert.equal(files[0].uri, pathToFileURL(path).href);
    await assert.rejects(prepareOpencodeAttachments([{ ...inline, dataUrl: undefined, path: './relative.png' }]), /no readable content/);
    await assert.rejects(prepareOpencodeAttachments([{ ...inline, dataUrl: undefined, path: join(dir, 'missing.png') }]), /no longer readable/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invalid inline, oversized and unsupported attachments cannot silently disappear', async () => {
  for (const dataUrl of ['https://example.com/image.png', 'data:image/png;base64,!', 'data:text/plain;base64,Ynl0ZXM=']) {
    await assert.rejects(prepareOpencodeAttachments([{ ...inline, dataUrl }]), /invalid inline content/);
  }
  await assert.rejects(prepareOpencodeAttachments([{ ...inline, size: OPENCODE_ATTACHMENT_BYTES + 1 }]), /20 MiB/);
  await assert.rejects(prepareOpencodeAttachments([{ ...inline, mimeType: 'audio/mpeg', kind: 'audio' }]), /cannot send.*audio\/mpeg/);
});

test('known model modalities reach both config builders and unknown models forward requested media without mutating defaults', async () => {
  const capabilities = { ...UNKNOWN_CAPABILITIES, inputModalities: ['text', 'image'] };
  const common = { modelIds: ['vision'], modelId: 'vision', mode: 'agent' as const, permissionLevel: 'default' as const, capabilities };
  for (const built of [buildOpencodeConfig({ ...common, baseUrl: 'http://localhost:11434' }), buildZenOpencodeConfig(common)]) {
    const [provider, model] = built.modelRef.split('/');
    assert.deepEqual((built.config.provider as any)[provider].models[model].modalities, { input: ['text', 'image'], output: ['text'] });
    assert.doesNotThrow(() => opencodeAttachmentConfig(built.config, built.modelRef, [{ uri: inline.dataUrl, name: inline.name, mime: inline.mimeType }]));
  }
  const built = buildOpencodeConfig({ ...common, capabilities: UNKNOWN_CAPABILITIES, baseUrl: 'http://localhost:11434' });
  const files = await prepareOpencodeAttachments([inline]);
  const configured = opencodeAttachmentConfig(built.config, built.modelRef, files);
  assert.notEqual(configured, built.config);
  assert.equal((built.config.provider as any)['melink-ollama-cloud'].models.vision.modalities, undefined);
});

test('vision metadata is truthful and known text-only models reject image attachments', () => {
  const vision = ollamaCapabilities({ capabilities: ['vision', 'tools'] }, ['agent']);
  assert.deepEqual(vision.inputModalities, ['text', 'image']);
  assert.equal(ollamaCapabilities({}, ['agent']).inputModalities, undefined);
  const capabilities = ollamaCapabilities({ capabilities: ['completion'] }, ['agent']);
  const built = buildOpencodeConfig({ baseUrl: 'http://localhost:11434', modelIds: ['text'], modelId: 'text', mode: 'ask', permissionLevel: 'read-only', capabilities });
  assert.throws(() => opencodeAttachmentConfig(built.config, built.modelRef, [{ uri: inline.dataUrl, name: inline.name, mime: inline.mimeType }]), /does not support/);
});
