import test from 'node:test';
import assert from 'node:assert/strict';
import { friendlyToolTitle, targetForTool, toolCardPresentation } from './toolLabel.ts';

test('friendly titles name the action and the real target', () => {
  assert.equal(friendlyToolTitle('read', 'src/webview/App.tsx'), 'Reading App.tsx');
  assert.equal(friendlyToolTitle('grep', 'transcriptRef'), 'Searching for transcriptRef');
  assert.equal(friendlyToolTitle('search', 'token'), 'Searching for token');
  assert.equal(friendlyToolTitle('glob', '**/*.ts'), 'Finding files **/*.ts');
  assert.equal(friendlyToolTitle('bash', 'npm test'), 'Running npm test');
  assert.equal(friendlyToolTitle('edit', 'src/a.ts'), 'Editing a.ts');
  assert.equal(friendlyToolTitle('write', 'notes.md'), 'Writing notes.md');
  assert.equal(friendlyToolTitle('list', 'src'), 'Listing src');
});

test('a missing target stays a verb and never invents a path', () => {
  assert.equal(friendlyToolTitle('read'), 'Reading');
  assert.equal(friendlyToolTitle('glob'), 'Finding files');
  assert.equal(friendlyToolTitle('bash'), 'Running command');
  assert.equal(friendlyToolTitle('read', 'completed'), 'Reading');
  assert.equal(friendlyToolTitle('grep', 'completed'), 'Searching');
});

test('command titles unwrap common shell launchers and keep command quoting', () => {
  const cases = [
    ['"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-Content package.json"', 'Get-Content package.json'],
    ["pwsh -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command 'npm run build'", 'npm run build'],
    ['powershell.exe -c "npm test"', 'npm test'],
    ["/bin/bash -lc 'npm run lint && npm test'", 'npm run lint && npm test'],
    ['sh -c "echo hello"', 'echo hello'],
    ["zsh --login -c 'git status'", 'git status'],
    ['cmd.exe /d /s /c "npm run build"', 'npm run build'],
    ['cmd /c dir src', 'dir src'],
    ['bash -c "pwsh -Command npm test"', 'npm test'],
    ["bash -lc 'rg \"two words\" src'", 'rg "two words" src'],
    ['pwsh -Command "Get-Content package.json\nGet-Location"', 'Get-Content package.json'],
    ['npm test', 'npm test']
  ];
  for (const [command, expected] of cases) {
    for (const tool of ['command', 'bash', 'shell', 'exec', 'powershell']) {
      assert.equal(friendlyToolTitle(tool, command), `Running ${expected}`, command);
    }
  }
});

test('unsupported, incomplete and script-file launchers retain their original title', () => {
  for (const command of [
    'pwsh -EncodedCommand bm9wZQ==',
    'powershell -File build.ps1',
    'bash build.sh',
    'bash -c',
    'bash -c ""',
    'bash -c "npm test',
    "bash -c 'echo hello' argument",
    'bash -c "npm test" "argument"',
    'bash -c npm test',
    '/bin/sh -c echo hello',
    'zsh -lc npm run build',
    'dash -c npm test',
    'ksh -c npm test',
    'custom-shell -c "npm test"',
    'echo powershell -Command npm test'
  ]) {
    assert.equal(friendlyToolTitle('command', command), `Running ${command}`);
  }
});

test('live and replayed command cards simplify only the title and preserve full detail', () => {
  const command = '"C:/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe" -Command "npm run build"';
  for (const title of ['command', `Running ${command}`, friendlyToolTitle('command', command)]) {
    assert.deepEqual(toolCardPresentation({ title, command, detail: 'build output' }), {
      title: 'Running npm run build',
      detail: command
    });
  }
  assert.deepEqual(toolCardPresentation({ title: 'Checking the build', command }), {
    title: 'Checking the build',
    detail: command
  });
});

test('tool targets come from the call payload, not the status', () => {
  assert.equal(targetForTool('read', { filePath: 'src/App.tsx' }), 'src/App.tsx');
  assert.equal(targetForTool('grep', { pattern: 'token', path: 'src' }), 'token');
  assert.equal(targetForTool('glob', { pattern: '**/*.ts' }), '**/*.ts');
  assert.equal(targetForTool('bash', { command: 'ls', description: 'list' }), 'ls');
  assert.equal(targetForTool('read', { filePath: 'completed' }), undefined);
});

test('a zvec-grep semantic search says what is being searched', () => {
  const query = 'An unseen creature left a few marks. What did the detective infer?';
  assert.equal(
    targetForTool('zvec_grep_zvec_grep_search', { root: '/ws', query, fts: ['marks', 'detective'], fuse: true }),
    query
  );
  assert.equal(friendlyToolTitle('zvec_grep_zvec_grep_search', query), `Searching for ${query}`);
  assert.equal(friendlyToolTitle('zvec_grep_search'), 'Searching');
  assert.equal(
    targetForTool('mcp__zvec_grep__zvec_grep_search', { fts: ['marks', 'detective'] }),
    'marks, detective'
  );
});

test('an ast-grep structural search names the pattern', () => {
  assert.equal(targetForTool('ast_grep_search', { pattern: 'console.log($A)', lang: 'ts' }), 'console.log($A)');
  assert.equal(friendlyToolTitle('ast_grep_search', 'console.log($A)'), 'Searching for console.log($A)');
  assert.equal(friendlyToolTitle('ast_grep_replace', 'foo($A)'), 'Rewriting foo($A)');
});

test('a collapsed card relabels a raw tool id and hides a status detail', () => {
  assert.deepEqual(toolCardPresentation({ title: 'glob', detail: 'completed' }), {
    title: 'Finding files',
    detail: undefined
  });
  assert.deepEqual(toolCardPresentation({ title: 'read', command: 'src/webview/App.tsx' }), {
    title: 'Reading App.tsx',
    detail: 'src/webview/App.tsx'
  });
  assert.deepEqual(toolCardPresentation({ title: 'grep', command: 'completed' }), {
    title: 'Searching',
    detail: undefined
  });
  assert.deepEqual(
    toolCardPresentation({ title: 'Running ls', command: 'ls' }),
    { title: 'Running ls', detail: 'ls' }
  );
});
