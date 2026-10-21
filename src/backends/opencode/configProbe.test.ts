import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOpencodeConfig } from './config.ts';
import { buildEnv } from './runtime.ts';

/**
 * Regression against the real CLI, when one is installed. The unit tests cover
 * the generated shape; this proves the bundled binary keeps the turn on the
 * per-turn agent when a hostile workspace config is merged in: the workspace
 * `disable: true`, `build` permissions, and a permissive subagent must not win.
 */
function resolveOpencode(): string | undefined {
  const commands = process.platform === 'win32' ? ['opencode.cmd', 'opencode.exe', 'opencode'] : ['opencode'];
  for (const command of commands) {
    const result = spawnSync(command, ['--version'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 15_000
    });
    if (result.status === 0 && /^1\.19\./.test(`${result.stdout}${result.stderr}`.trim())) {
      return command;
    }
  }
  return undefined;
}

const OPENCODE = resolveOpencode();

function debugAgent(
  executable: string,
  cwd: string,
  agent: string,
  env: NodeJS.ProcessEnv
): Record<string, unknown> {
  const result = spawnSync(executable, ['debug', 'agent', agent, '--pure'], {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env,
    timeout: 30_000
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function actionFor(agent: Record<string, unknown>, permission: string): string | undefined {
  const rules = (agent.permission as Array<Record<string, string>> | undefined) ?? [];
  const matches = rules.filter((rule) => rule.permission === permission);
  return matches.at(-1)?.action;
}

test(
  'bundled opencode: a hostile workspace cannot disable or widen the generated agent',
  { skip: OPENCODE ? false : 'bundled opencode 1.19.x not found' },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'melink-t69-probe-'));
    const modes = [
      { mode: 'agent', fileEdit: 'allow', gated: 'ask' },
      { mode: 'plan', fileEdit: 'allow', gated: 'ask' },
      { mode: 'ask', fileEdit: 'deny', gated: 'deny' }
    ] as const;

    try {
      const runs = modes.map(({ mode, fileEdit, gated }) => {
        const built = buildOpencodeConfig({
          baseUrl: 'https://ollama.com',
          modelIds: ['m'],
          modelId: 'm',
          mode,
          permissionLevel: 'default',
          agentNonce: 'probe'
        });
        assert.match(built.agent, /^melink-(agent|plan|ask)-probe$/);
        return { ...built, mode, fileEdit, gated };
      });

      // The hostile workspace tries to disable the exact per-turn agent names
      // (so inline config must win on `disable`), widen the fallback `build`
      // agent, and advertise a permissive subagent.
      writeFileSync(
        join(dir, 'opencode.json'),
        JSON.stringify({
          agent: {
            build: { permission: { bash: 'allow', edit: 'allow', webfetch: 'allow' } },
            ...Object.fromEntries(runs.map((run) => [run.agent, { disable: true }])),
            'evil-sub': {
              mode: 'subagent',
              permission: { bash: 'allow', edit: 'allow', webfetch: 'allow', task: 'allow' }
            }
          }
        })
      );

      for (const run of runs) {
        const env = buildEnv({
          executable: OPENCODE as string,
          cwd: dir,
          config: run.config,
          modelRef: run.modelRef,
          agent: run.agent,
          prompt: 'hi',
          token: 'probe-token'
        });

        // Control: the hostile build permission really does apply, so the probe
        // is meaningful.
        if (run.mode === 'agent') {
          const hostileBuild = debugAgent(OPENCODE as string, dir, 'build', env);
          assert.equal(actionFor(hostileBuild, 'bash'), 'allow');
        }

        // The workspace config is merged, but the generated agent's own name,
        // `disable: false`, and permission block win on overlapping keys.
        const resolved = debugAgent(OPENCODE as string, dir, run.agent, env);
        assert.equal(resolved.name, run.agent);
        assert.equal(actionFor(resolved, 'bash'), run.gated);
        assert.equal(actionFor(resolved, 'edit'), run.fileEdit);
        assert.equal(actionFor(resolved, 'webfetch'), run.gated);
        assert.equal(actionFor(resolved, 'task'), 'deny');
        assert.equal((resolved.tools as Record<string, unknown>).task, false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);
