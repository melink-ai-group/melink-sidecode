/**
 * ChatGPT token refresh for the app-server's `account/chatgptAuthTokens/refresh`
 * request.
 *
 * The CLI stores the ChatGPT login in `auth.json`. When a turn is rejected as
 * unauthorized, the server asks this client for a new access token and does not
 * proceed until that request is answered. Refreshing goes to the public Codex
 * OAuth endpoint with the saved refresh token. Nothing here logs, and no error
 * message includes a token or the response body.
 */

import { homedir } from 'node:os';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import type { ChatgptAuthTokensRefreshResponse } from '../../../schemas/v2/ChatgptAuthTokensRefreshResponse.ts';

/** The public Codex CLI OAuth client, taken from the installed `codex` binary. */
const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const AUTH_CLAIM = 'https://api.openai.com/auth';

const REFRESH_FAILED = 'Codex could not refresh the ChatGPT login.';
const NO_REFRESH_TOKEN = 'Codex has no ChatGPT refresh token. Sign in with the Codex CLI, then try again.';
const ACCOUNT_MISMATCH = 'The saved Codex login is for a different account.';

/** A refresh failure whose message is safe to show. */
export class TokenRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenRefreshError';
  }
}

export interface RefreshIo {
  authPath: string;
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, data: string) => Promise<void>;
  fetch: typeof fetch;
  previousAccountId?: string | null;
}

/** `CODEX_HOME/auth.json`, or `~/.codex/auth.json` when `CODEX_HOME` is unset. */
export function codexAuthFilePath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const root = env.CODEX_HOME?.trim() || path.join(home, '.codex');
  return path.join(root, 'auth.json');
}

/**
 * Refresh the saved ChatGPT login and return the token fields the app-server
 * asked for. The auth file is updated when the server rotates the refresh token.
 */
export async function refreshChatgptAuth(io: RefreshIo): Promise<ChatgptAuthTokensRefreshResponse> {
  const stored = await readAuth(io);
  const refreshToken = stringField(stored.tokens, 'refresh_token');
  if (!refreshToken) {
    throw new TokenRefreshError(NO_REFRESH_TOKEN);
  }
  const storedAccount = stringField(stored.tokens, 'account_id');
  if (io.previousAccountId && storedAccount && io.previousAccountId !== storedAccount) {
    throw new TokenRefreshError(ACCOUNT_MISMATCH);
  }

  let response: Response;
  try {
    response = await io.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenRequestBody(refreshToken),
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    throw new TokenRefreshError(REFRESH_FAILED);
  }
  if (!response.ok) {
    throw new TokenRefreshError(REFRESH_FAILED);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new TokenRefreshError(REFRESH_FAILED);
  }
  const accessToken = stringField(body, 'access_token');
  if (!accessToken) {
    throw new TokenRefreshError(REFRESH_FAILED);
  }
  const nextRefresh = stringField(body, 'refresh_token') ?? refreshToken;
  const nextId = stringField(body, 'id_token');
  const accountId = accountIdFromToken(accessToken) ?? storedAccount;
  if (!accountId) {
    throw new TokenRefreshError(REFRESH_FAILED);
  }

  const tokens = { ...(stored.tokens as Record<string, unknown>) };
  tokens.access_token = accessToken;
  tokens.refresh_token = nextRefresh;
  if (nextId) {
    tokens.id_token = nextId;
  }
  if (!stringField(tokens, 'account_id')) {
    tokens.account_id = accountId;
  }
  const next = { ...stored, tokens, last_refresh: new Date().toISOString() };
  await io.writeFile(io.authPath, `${JSON.stringify(next, null, 2)}\n`);

  return {
    accessToken,
    chatgptAccountId: accountId,
    chatgptPlanType: planTypeFromToken(accessToken)
  };
}

/** Refresh using the real auth file and `fetch`. */
export function refreshStoredChatgptAuth(
  previousAccountId?: string | null
): Promise<ChatgptAuthTokensRefreshResponse> {
  const authPath = codexAuthFilePath();
  return refreshChatgptAuth({
    authPath,
    previousAccountId,
    readFile: (filePath) => readFile(filePath, 'utf8'),
    writeFile: (filePath, data) => writeFile(filePath, data, { mode: 0o600 }),
    fetch: globalThis.fetch
  });
}

/** Form body for the Codex refresh grant. The refresh token is the only secret. */
export function tokenRequestBody(refreshToken: string): string {
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('client_id', CODEX_OAUTH_CLIENT_ID);
  body.set('refresh_token', refreshToken);
  return body.toString();
}

async function readAuth(io: RefreshIo): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await io.readFile(io.authPath);
  } catch {
    throw new TokenRefreshError(REFRESH_FAILED);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TokenRefreshError(REFRESH_FAILED);
  }
  if (!isRecord(parsed) || !isRecord(parsed.tokens)) {
    throw new TokenRefreshError(NO_REFRESH_TOKEN);
  }
  return parsed;
}

function accountIdFromToken(token: string): string | undefined {
  return stringField(authClaim(token), 'chatgpt_account_id');
}

function planTypeFromToken(token: string): string | null {
  return stringField(authClaim(token), 'chatgpt_plan_type') ?? null;
}

function authClaim(token: string): unknown {
  const part = token.split('.')[1];
  if (!part) {
    return undefined;
  }
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
    if (!isRecord(payload)) {
      return undefined;
    }
    return payload[AUTH_CLAIM];
  } catch {
    return undefined;
  }
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const field = value[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
