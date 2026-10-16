import { isSupportedCodexVersion, parseCodexVersion } from '../appserver/version.ts';

/**
 * The app-server methods the adapter calls. A newer CLI is allowed only when
 * its generated protocol still names every one of them, and a live handshake
 * still answers the calls the sidebar makes on startup.
 */
export const REQUIRED_APP_SERVER_METHODS: readonly string[] = [
  'initialize',
  'thread/start',
  'thread/resume',
  'thread/delete',
  'thread/list',
  'thread/turns/list',
  'thread/items/list',
  'thread/compact/start',
  'model/list',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
  'getAuthStatus'
];

/** What a live probe observed. Thrown calls are already turned into `failures`. */
export interface ProtocolProbe {
  userAgent?: string;
  modelList?: unknown;
  threadList?: unknown;
  authStatus?: unknown;
  failures: readonly string[];
}

export interface VersionCheckPart {
  ok: boolean;
  version?: string;
  message: string;
}

export interface CodexVersionCheckResult {
  ok: boolean;
  version?: string;
  message: string;
}

/** Generated protocol text the method and priming-field checks read. */
export interface GeneratedProtocol {
  clientRequest: string;
  threadStartParams: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Decide whether a live handshake is the protocol this app drives. A signed-out
 * CLI still passes: auth state is not a protocol check. Nothing in the result
 * copies a token.
 */
export function assessProtocolProbe(probe: ProtocolProbe): VersionCheckPart {
  if (probe.failures.length > 0) {
    return { ok: false, message: probe.failures[0] ?? 'The Codex protocol check did not finish.' };
  }
  const version = parseCodexVersion(probe.userAgent)?.raw;
  if (!version) {
    return {
      ok: false,
      message: 'The Codex CLI did not report a protocol version, so it is still unsupported.'
    };
  }
  if (!isRecord(probe.modelList) || !Array.isArray(probe.modelList.data)) {
    return {
      ok: false,
      version,
      message: `Codex ${version} answered model/list in a shape this app does not use, so it is still unsupported.`
    };
  }
  if (!isRecord(probe.threadList) || !Array.isArray(probe.threadList.data)) {
    return {
      ok: false,
      version,
      message: `Codex ${version} answered thread/list in a shape this app does not use, so it is still unsupported.`
    };
  }
  if (!isRecord(probe.authStatus) || !('authMethod' in probe.authStatus || 'requiresOpenaiAuth' in probe.authStatus)) {
    return {
      ok: false,
      version,
      message: `Codex ${version} answered getAuthStatus in a shape this app does not use, so it is still unsupported.`
    };
  }
  return { ok: true, version, message: '' };
}

/** Methods named by a generated `ClientRequest` union. */
export function appServerMethods(clientRequestSource: string): string[] {
  return [...clientRequestSource.matchAll(/"method": "([^"]+)"/g)].map((match) => match[1] ?? '');
}

/**
 * Whether generated bindings still expose the methods and the thread-start
 * field the adapter sends. Extra methods are fine; a missing one is not.
 */
export function assessGeneratedProtocol(protocol: GeneratedProtocol): VersionCheckPart {
  const present = new Set(appServerMethods(protocol.clientRequest));
  const missing = REQUIRED_APP_SERVER_METHODS.filter((method) => !present.has(method));
  if (missing.length > 0) {
    return {
      ok: false,
      message: `This Codex version no longer offers ${missing.join(', ')}, so it is still unsupported.`
    };
  }
  if (!protocol.threadStartParams.includes('developerInstructions')) {
    return {
      ok: false,
      message: 'This Codex version no longer accepts developer instructions on thread start, so it is still unsupported.'
    };
  }
  return { ok: true, message: '' };
}

/** Combine the live probe and the generated-protocol check into the sentence the settings screen shows. */
export function versionCheckResult(probe: VersionCheckPart, protocol: VersionCheckPart): CodexVersionCheckResult {
  if (!probe.ok) {
    return { ok: false, ...(probe.version ? { version: probe.version } : {}), message: probe.message };
  }
  if (!protocol.ok) {
    return { ok: false, ...(probe.version ? { version: probe.version } : {}), message: protocol.message };
  }
  const version = probe.version;
  if (version && isSupportedCodexVersion(version)) {
    return {
      ok: true,
      version,
      message: `Codex ${version} is already in the supported range.`
    };
  }
  return {
    ok: true,
    ...(version ? { version } : {}),
    message: version
      ? `Codex ${version} passed the protocol checks and is now allowed.`
      : 'This Codex version passed the protocol checks and is now allowed.'
  };
}
