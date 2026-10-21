import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commandMatchKey,
  commandPrefix,
  describeApproval,
  findMatchingRule,
  migrateApprovalRules,
  ruleFor,
  ruleMatchesRequest,
  ruleScopeFor,
  sessionKey,
  tokenize
} from './approvals.ts';
import type { ApprovalRequest, ApprovalRule } from './types.ts';

function commandRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'req_1',
    kind: 'command',
    method: 'item/commandExecution/requestApproval',
    command: 'git status',
    origin: '/workspace',
    ...overrides
  };
}

function fileRequest(paths: string[], overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'req_2',
    kind: 'file-change',
    method: 'item/fileChange/requestApproval',
    paths,
    ...overrides
  };
}

test('a decision maps to the scope it really persists', () => {
  assert.equal(ruleScopeFor('allow-once'), 'none');
  assert.equal(ruleScopeFor('reject'), 'none');
  assert.equal(ruleScopeFor('allow-always'), 'global');
  assert.equal(ruleScopeFor('allow-session'), 'session');
});

test('an always rule records the native exec-policy amendment it was offered', () => {
  const request = commandRequest({ execPolicyAmendment: ['git', 'status'] });
  const rule = ruleFor(request, 'codex', 1000);
  assert.equal(rule.backendId, 'codex');
  assert.equal(rule.kind, 'command');
  assert.deepEqual(rule.execPolicyAmendment, ['git', 'status']);
  assert.equal(rule.origin, '/workspace');
  assert.equal(rule.createdAt, 1000);
});

test('a command rule records the command family, not just the first token', () => {
  const rule = ruleFor(commandRequest({ command: 'git commit -m "x"' }), 'codex', 1);
  assert.deepEqual(rule.commandFamily, ['git', 'commit']);
  assert.deepEqual(rule.commandPrefix, ['git', 'commit']);
  assert.equal(rule.commandExact, false);
  assert.equal(rule.gitWrite, true);
  assert.equal(rule.execPolicyAmendment, undefined);
});

test('the native amendment is recorded verbatim while matching uses the family', () => {
  // The CLI proposed the broad `git` prefix, but the rule must still match on
  // the family the user actually saw.
  const rule = ruleFor(
    commandRequest({ command: 'git status', execPolicyAmendment: ['git'] }),
    'codex',
    1
  );
  assert.deepEqual(rule.execPolicyAmendment, ['git']);
  assert.deepEqual(rule.commandFamily, ['git', 'status']);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git status' })), true);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git commit' })), false);
});

test('a git status rule never covers a write', () => {
  const rule = ruleFor(commandRequest({ command: 'git status' }), 'codex', 1);
  assert.deepEqual(rule.commandFamily, ['git', 'status']);
  assert.equal(rule.gitWrite, false);

  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git status --short' })), true);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git commit' })), false);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git push' })), false);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git reset --hard' })), false);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git checkout main' })), false);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git clean -fd' })), false);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git merge feature' })), false);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git rebase main' })), false);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git tag v1' })), false);
});

test('a rule for one program never covers another', () => {
  const rule = ruleFor(commandRequest({ command: 'git status' }), 'codex', 1);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'npm test' })), false);
});

test('a non-git rule keeps the program path, so another path never matches', () => {
  const rule = ruleFor(commandRequest({ command: '/opt/tool run' }), 'codex', 1);
  assert.deepEqual(rule.commandFamily, ['/opt/tool', 'run']);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: '/opt/tool run' })), true);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: '/tmp/tool run' })), false);
});

test('an npm test rule never covers npm publish', () => {
  const rule = ruleFor(commandRequest({ command: 'npm test' }), 'codex', 1);
  assert.deepEqual(rule.commandFamily, ['npm', 'test']);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'npm test -- --watch' })), true);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'npm publish' })), false);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'npm run build' })), false);
});

test('an npm run build rule is its own family', () => {
  const rule = ruleFor(commandRequest({ command: 'npm run build' }), 'codex', 1);
  assert.deepEqual(rule.commandFamily, ['npm', 'run', 'build']);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'npm run build -- --watch' })), true);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'npm test' })), false);
});

test('a non-git command with a non-flag token after a flag is exact', () => {
  const silentBuild = ruleFor(commandRequest({ command: 'npm run --silent build' }), 'codex', 1);
  assert.equal(silentBuild.commandExact, true);
  assert.deepEqual(silentBuild.commandFamily, ['npm', 'run', '--silent', 'build']);
  assert.equal(
    ruleMatchesRequest(silentBuild, commandRequest({ command: 'npm run --silent build' })),
    true
  );
  assert.equal(
    ruleMatchesRequest(silentBuild, commandRequest({ command: 'npm run --silent publish' })),
    false
  );

  const silentPublish = ruleFor(commandRequest({ command: 'npm run --silent publish' }), 'codex', 1);
  assert.equal(silentPublish.commandExact, true);
  assert.equal(
    ruleMatchesRequest(silentPublish, commandRequest({ command: 'npm run --silent build' })),
    false
  );

  const ls = commandMatchKey('ls -la /tmp');
  assert.equal(ls?.exact, true);
  assert.deepEqual(ls?.family, ['ls', '-la', '/tmp']);

  // Trailing flags only do not hide another token, so the family remains.
  const npmTestWatch = commandMatchKey('npm test -- --watch');
  assert.deepEqual(npmTestWatch?.family, ['npm', 'test']);
  assert.equal(npmTestWatch?.exact, false);

  // Git is exempt: arguments after the subcommand only drive read/write.
  const commit = commandMatchKey('git commit -m "x"');
  assert.deepEqual(commit?.family, ['git', 'commit']);
  assert.equal(commit?.exact, false);
});

test('a read-only git branch rule covers only the read-only forms', () => {
  const rule = ruleFor(commandRequest({ command: 'git branch' }), 'codex', 1);
  assert.deepEqual(rule.commandFamily, ['git', 'branch']);
  assert.equal(rule.gitWrite, false);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git branch' })), true);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git branch -a' })), true);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git branch -D feat' })), false);
});

test('git detection is case-insensitive, so a mixed-case program cannot bypass the guard', () => {
  const branchRule = ruleFor(commandRequest({ command: 'GIT branch' }), 'codex', 1);
  assert.deepEqual(branchRule.commandFamily, ['GIT', 'branch']);
  assert.equal(branchRule.gitWrite, false);
  assert.equal(ruleMatchesRequest(branchRule, commandRequest({ command: 'GIT branch -a' })), true);
  assert.equal(
    ruleMatchesRequest(branchRule, commandRequest({ command: 'GIT branch -D feat' })),
    false
  );

  const statusRule = ruleFor(commandRequest({ command: 'GIT status' }), 'codex', 1);
  assert.equal(statusRule.gitWrite, false);
  assert.equal(ruleMatchesRequest(statusRule, commandRequest({ command: 'GIT status --short' })), true);
  assert.equal(ruleMatchesRequest(statusRule, commandRequest({ command: 'GIT push' })), false);

  const commit = commandMatchKey('Git commit -m "x"');
  assert.deepEqual(commit?.family, ['Git', 'commit']);
  assert.equal(commit?.gitWrite, true);
  const commitRule = ruleFor(commandRequest({ command: 'Git commit' }), 'codex', 1);
  assert.equal(commitRule.gitWrite, true);
  assert.equal(ruleMatchesRequest(commitRule, commandRequest({ command: 'Git commit -m "x"' })), true);

  // The Windows spelling is git too, under any casing.
  assert.equal(commandMatchKey('GIT.exe push')?.gitWrite, true);
  assert.deepEqual(commandMatchKey('Git.EXE status')?.family, ['Git', 'status']);
});

test('a read-only git tag rule never covers deleting a tag', () => {
  const rule = ruleFor(commandRequest({ command: 'git tag' }), 'codex', 1);
  assert.deepEqual(rule.commandFamily, ['git', 'tag']);
  assert.equal(rule.gitWrite, false);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git tag' })), true);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git tag -d' })), false);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git tag -d v1' })), false);
});

test('a read-only git subcommand with an output flag is a write', () => {
  const diffRule = ruleFor(commandRequest({ command: 'git diff' }), 'codex', 1);
  assert.equal(diffRule.gitWrite, false);
  assert.equal(ruleMatchesRequest(diffRule, commandRequest({ command: 'git diff --output=out.txt' })), false);
  assert.equal(ruleMatchesRequest(diffRule, commandRequest({ command: 'git diff -o out.txt' })), false);

  const logRule = ruleFor(commandRequest({ command: 'git log' }), 'codex', 1);
  assert.equal(logRule.gitWrite, false);
  assert.equal(ruleMatchesRequest(logRule, commandRequest({ command: 'git log -o out.txt' })), false);

  assert.equal(commandMatchKey('git diff --output=out.txt')?.gitWrite, true);
  assert.equal(commandMatchKey('git diff -o out.txt')?.gitWrite, true);
  assert.equal(commandMatchKey('git log -o out.txt')?.gitWrite, true);
});

test('a write rule covers its own write family but nothing else', () => {
  const rule = ruleFor(commandRequest({ command: 'git commit' }), 'codex', 1);
  assert.equal(rule.gitWrite, true);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git commit -m "x"' })), true);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git push' })), false);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git status' })), false);
});

test('shell composition cannot ride a command family', () => {
  const rule = ruleFor(commandRequest({ command: 'git status' }), 'codex', 1);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git status && git push' })), false);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git status; git push' })), false);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git status | sh' })), false);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git status || git push' })), false);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git status\ngit push' })), false);
  // A composed command is not even classifiable, so no rule can cover it.
  assert.equal(commandMatchKey('git status && git push'), undefined);
});

test('substitution inside double quotes is not a simple command', () => {
  const rule = ruleFor(commandRequest({ command: 'git status' }), 'codex', 1);
  assert.equal(
    ruleMatchesRequest(rule, commandRequest({ command: 'git status "--format=`git push`"' })),
    false
  );
  assert.equal(
    ruleMatchesRequest(rule, commandRequest({ command: 'git status "--format=$(git push)"' })),
    false
  );
  assert.equal(
    ruleMatchesRequest(rule, commandRequest({ command: 'git status "--format=${HOME}"' })),
    false
  );
  assert.equal(commandMatchKey('git status "--format=`git push`"'), undefined);
  assert.equal(commandMatchKey('git status "--format=$(git push)"'), undefined);

  // Single quotes are literal, so the same text there is still a status read.
  const quoted = commandMatchKey("git status '--format=`git push`'");
  assert.deepEqual(quoted?.family, ['git', 'status']);
  assert.equal(
    ruleMatchesRequest(rule, commandRequest({ command: "git status '--format=`git push`'" })),
    true
  );
});

test('an environment assignment in front of a command is never auto-approved', () => {
  const rule = ruleFor(commandRequest({ command: 'git status' }), 'codex', 1);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'FOO=bar git status' })), false);
  assert.equal(commandMatchKey('FOO=bar git status'), undefined);
});

test('a git command with a global flag is matched exactly, never by family', () => {
  const rule = ruleFor(commandRequest({ command: 'git -C repo status' }), 'codex', 1);
  assert.equal(rule.commandExact, true);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git -C repo status' })), true);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git -C repo commit' })), false);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git status' })), false);
});

test('a wrapper command is matched exactly, never by family', () => {
  const rule = ruleFor(commandRequest({ command: 'bash -c "git status"' }), 'codex', 1);
  assert.equal(rule.commandExact, true);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'bash -c "git status"' })), true);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'bash -c "git push"' })), false);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git status' })), false);
});

test('a rule for an unclassifiable command never matches anything else', () => {
  const rule = ruleFor(commandRequest({ command: 'git status && git push' }), 'codex', 1);
  assert.equal(rule.commandFamily, undefined);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git status && git push' })), false);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git status' })), false);
});

test('the native amendment is never a fallback for an unclassifiable command', () => {
  const rule = ruleFor(
    commandRequest({ command: 'git status && git push', execPolicyAmendment: ['git', 'status'] }),
    'codex',
    1
  );
  assert.equal(rule.commandFamily, undefined);
  assert.deepEqual(rule.execPolicyAmendment, ['git', 'status']);
  assert.equal(
    ruleMatchesRequest(rule, commandRequest({ command: 'git status && git push' })),
    false
  );
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git status' })), false);
});

test('a command rule never matches a different kind of request', () => {
  const rule = ruleFor(commandRequest({ command: 'git status' }), 'codex', 1);
  const fileRequest: ApprovalRequest = {
    id: 'r2',
    kind: 'file-change',
    method: 'item/fileChange/requestApproval',
    paths: ['/workspace/file.ts']
  };
  assert.equal(ruleMatchesRequest(rule, fileRequest), false);
});

test('a file-change rule records the root it is scoped to', () => {
  const rule = ruleFor(
    { id: 'r', kind: 'file-change', method: 'item/fileChange/requestApproval', paths: ['/workspace/src'] },
    'codex',
    1
  );
  assert.deepEqual(rule.paths, ['/workspace/src']);
  assert.equal(rule.kind, 'file-change');
});

test('a grant-root file-change rule records that root as its scope', () => {
  const rule = ruleFor(
    {
      id: 'r',
      kind: 'file-change',
      method: 'item/fileChange/requestApproval',
      grantRoot: '/workspace/extra'
    },
    'codex',
    1
  );
  assert.deepEqual(rule.paths, ['/workspace/extra']);
});

test('a file rule matches only paths under its recorded root', () => {
  const rule = ruleFor(
    { id: 'r', kind: 'file-change', method: 'item/fileChange/requestApproval', paths: ['/workspace/src'] },
    'codex',
    1
  );
  assert.equal(ruleMatchesRequest(rule, fileRequest(['/workspace/src/index.ts'])), true);
  assert.equal(ruleMatchesRequest(rule, fileRequest(['/etc/passwd'])), false);
});

test('a file rule matches at a directory boundary, never a sibling prefix', () => {
  const rule = ruleFor(
    { id: 'r', kind: 'file-change', method: 'item/fileChange/requestApproval', paths: ['/ws/src'] },
    'codex',
    1
  );
  assert.equal(ruleMatchesRequest(rule, fileRequest(['/ws/src'])), true);
  assert.equal(ruleMatchesRequest(rule, fileRequest(['/ws/src/index.ts'])), true);
  assert.equal(ruleMatchesRequest(rule, fileRequest(['/ws/src/'])), true);
  assert.equal(ruleMatchesRequest(rule, fileRequest(['/ws//src//index.ts'])), true);
  assert.equal(ruleMatchesRequest(rule, fileRequest(['/WS/SRC/index.ts'])), true);
  assert.equal(ruleMatchesRequest(rule, fileRequest(['/ws/src-evil/x.ts'])), false);
  assert.equal(ruleMatchesRequest(rule, fileRequest(['/ws/srcery/x.ts'])), false);
});

test('a grant-root request is covered at the boundary too', () => {
  const rule = ruleFor(
    { id: 'r', kind: 'file-change', method: 'item/fileChange/requestApproval', grantRoot: '/ws/src' },
    'codex',
    1
  );
  assert.deepEqual(rule.paths, ['/ws/src']);
  assert.equal(
    ruleMatchesRequest(rule, {
      id: 'r2',
      kind: 'file-change',
      method: 'item/fileChange/requestApproval',
      grantRoot: '/ws/src'
    }),
    true
  );
  assert.equal(
    ruleMatchesRequest(rule, {
      id: 'r3',
      kind: 'file-change',
      method: 'item/fileChange/requestApproval',
      grantRoot: '/ws/src/nested'
    }),
    true
  );
  assert.equal(
    ruleMatchesRequest(rule, {
      id: 'r4',
      kind: 'file-change',
      method: 'item/fileChange/requestApproval',
      grantRoot: '/ws/src-evil'
    }),
    false
  );
});

test('a permissions rule matches only the same network host', () => {
  const rule: ApprovalRule = {
    id: 'r',
    backendId: 'codex',
    kind: 'permissions',
    scope: 'network access to example.test',
    host: 'example.test',
    createdAt: 1
  };
  assert.equal(ruleMatchesRequest(rule, commandRequest({ kind: 'permissions', network: 'example.test' })), true);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ kind: 'permissions', network: 'other.test' })), false);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ kind: 'permissions' })), false);
});

test('a session rule is preferred over a global rule for the same request', () => {
  const session = { ...ruleFor(commandRequest({ command: 'git status' }), 'codex', 1), id: 'session' };
  const global = { ...ruleFor(commandRequest({ command: 'git status' }), 'codex', 2), id: 'global' };
  const matched = findMatchingRule(commandRequest({ command: 'git status --short' }), [session], [global]);
  assert.equal(matched?.id, 'session');
});

test('a request no rule covers matches nothing, so the user must be asked', () => {
  const global: ApprovalRule[] = [ruleFor(commandRequest({ command: 'git status' }), 'codex', 1)];
  assert.equal(findMatchingRule(commandRequest({ command: 'rm -rf /' }), [], global), undefined);
});

test('the session key is per backend and per thread, so scopes cannot leak', () => {
  assert.equal(sessionKey('codex', 'thread-1'), 'codex:thread-1');
  assert.notEqual(sessionKey('codex', 'thread-1'), sessionKey('codex', 'thread-2'));
  assert.notEqual(sessionKey('codex', 'thread-1'), sessionKey('ollama', 'thread-1'));
});

test('describeApproval names the command or path scope it actually covers', () => {
  assert.equal(describeApproval(commandRequest({ command: 'ls' })), 'ls');
  assert.equal(describeApproval(commandRequest({ command: undefined })), 'a command');
  assert.equal(describeApproval({ id: 'r', kind: 'file-change', method: 'x', paths: ['/a'] }), 'writes under /a');
  assert.equal(
    describeApproval({ id: 'r', kind: 'file-change', method: 'x', paths: ['/a', '/b'] }),
    'writes under 2 paths'
  );
});

test('tokenize keeps quoted groups and commandPrefix takes the first token', () => {
  assert.deepEqual(tokenize('git commit -m "two words"'), ['git', 'commit', '-m', 'two words']);
  assert.deepEqual(commandPrefix('  git   status  '), ['git']);
  assert.deepEqual(commandPrefix(''), []);
});

test('a legacy command rule without a family is dropped and never matches', () => {
  const legacy: ApprovalRule = {
    id: 'legacy',
    backendId: 'codex',
    kind: 'command',
    scope: 'git',
    commandPrefix: ['git'],
    createdAt: 1
  };
  assert.equal(ruleMatchesRequest(legacy, commandRequest({ command: 'git push' })), false);
  assert.equal(ruleMatchesRequest(legacy, commandRequest({ command: 'git status' })), false);
  assert.deepEqual(migrateApprovalRules([legacy]), []);
});

test('the migration keeps file and permissions rules', () => {
  const legacy: ApprovalRule = {
    id: 'legacy',
    backendId: 'codex',
    kind: 'command',
    scope: 'git',
    commandPrefix: ['git'],
    createdAt: 1
  };
  const file: ApprovalRule = {
    id: 'file',
    backendId: 'codex',
    kind: 'file-change',
    scope: 'writes under /ws/src',
    paths: ['/ws/src'],
    createdAt: 2
  };
  const permissions: ApprovalRule = {
    id: 'perm',
    backendId: 'codex',
    kind: 'permissions',
    scope: 'network access to example.test',
    host: 'example.test',
    createdAt: 3
  };
  const current = ruleFor(commandRequest({ command: 'git status' }), 'codex', 4);

  const migrated = migrateApprovalRules([legacy, file, permissions, current]);
  assert.deepEqual(migrated.map((rule) => rule.id), ['file', 'perm', current.id]);
  // The kept rules still work.
  assert.equal(ruleMatchesRequest(file, fileRequest(['/ws/src/index.ts'])), true);
  assert.equal(ruleMatchesRequest(permissions, commandRequest({ kind: 'permissions', network: 'example.test' })), true);
});

test('commandMatchKey describes the family a rule is matched by', () => {
  const status = commandMatchKey('git status --short');
  assert.deepEqual(status?.family, ['git', 'status']);
  assert.equal(status?.exact, false);
  assert.equal(status?.gitWrite, false);
  assert.equal(status?.git, true);

  const commit = commandMatchKey('git commit -m "x"');
  assert.deepEqual(commit?.family, ['git', 'commit']);
  assert.equal(commit?.gitWrite, true);

  const npm = commandMatchKey('npm test -- --watch');
  assert.deepEqual(npm?.family, ['npm', 'test']);
  assert.equal(npm?.exact, false);

  const globalFlag = commandMatchKey('git -C repo status');
  assert.equal(globalFlag?.exact, true);
  assert.deepEqual(globalFlag?.family, ['git', '-C', 'repo', 'status']);

  const wrapper = commandMatchKey('bash -c "git status"');
  assert.equal(wrapper?.exact, true);

  assert.equal(commandMatchKey(undefined), undefined);
  assert.equal(commandMatchKey(''), undefined);
  assert.equal(commandMatchKey('git status && git push'), undefined);
});
