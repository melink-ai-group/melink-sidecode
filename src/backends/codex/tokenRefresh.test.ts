import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { refreshChatgptAuth, tokenRequestBody, TokenRefreshError } from './tokenRefresh.ts';

const REFRESH = 'refresh-token-value';
const ACCESS = jwt({
  'https://api.openai.com/auth': { chatgpt_account_id: 'acct_1', chatgpt_plan_type: 'plus' }
});

function jwt(payload: unknown): string {
  return `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

function authFile(): string {
  return JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: 'id-old',
      access_token: 'access-old',
      refresh_token: REFRESH,
      account_id: 'acct_1'
    }
  });
}

test('the refresh body names the Codex client and the refresh grant', () => {
  const body = new URLSearchParams(tokenRequestBody(REFRESH));
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.equal(body.get('refresh_token'), REFRESH);
});

test('a successful refresh returns the new access token and writes it back', async () => {
  let written = '';
  const result = await refreshChatgptAuth({
    authPath: 'auth.json',
    readFile: async () => authFile(),
    writeFile: async (_filePath, data) => {
      written = data;
    },
    fetch: async (_url, init) => {
      const params = new URLSearchParams(String(init?.body));
      assert.equal(params.get('refresh_token'), REFRESH);
      return new Response(JSON.stringify({ access_token: ACCESS, refresh_token: 'refresh-next', id_token: 'id-next' }), {
        status: 200
      });
    }
  });
  assert.equal(result.accessToken, ACCESS);
  assert.equal(result.chatgptAccountId, 'acct_1');
  assert.equal(result.chatgptPlanType, 'plus');
  const saved = JSON.parse(written) as { tokens: { access_token: string; refresh_token: string; id_token: string } };
  assert.equal(saved.tokens.access_token, ACCESS);
  assert.equal(saved.tokens.refresh_token, 'refresh-next');
  assert.equal(saved.tokens.id_token, 'id-next');
});

test('a missing refresh token and a failed response use fixed messages', async () => {
  await assert.rejects(
    refreshChatgptAuth({
      authPath: 'auth.json',
      readFile: async () => JSON.stringify({ tokens: { access_token: 'x' } }),
      writeFile: async () => undefined,
      fetch: async () => new Response('no', { status: 200 })
    }),
    (error: unknown) => error instanceof TokenRefreshError && error.message.includes('no ChatGPT refresh token')
  );

  await assert.rejects(
    refreshChatgptAuth({
      authPath: 'auth.json',
      readFile: async () => authFile(),
      writeFile: async () => undefined,
      fetch: async () => new Response(`denied ${REFRESH}`, { status: 401 })
    }),
    (error: unknown) => {
      assert.ok(error instanceof TokenRefreshError);
      assert.equal(error.message.includes(REFRESH), false);
      assert.match(error.message, /could not refresh/i);
      return true;
    }
  );
});

test('a different requested account is refused before any request', async () => {
  let called = false;
  await assert.rejects(
    refreshChatgptAuth({
      authPath: 'auth.json',
      previousAccountId: 'acct_other',
      readFile: async () => authFile(),
      writeFile: async () => undefined,
      fetch: async () => {
        called = true;
        return new Response('{}', { status: 200 });
      }
    }),
    (error: unknown) => error instanceof TokenRefreshError && /different account/.test(error.message)
  );
  assert.equal(called, false);
});

test('the refresh module does not log', async () => {
  const source = await readFile(join(process.cwd(), 'src', 'backends', 'codex', 'tokenRefresh.ts'), 'utf8');
  assert.equal(/\bconsole\./.test(source), false);
});
