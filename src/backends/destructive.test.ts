import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROMPT_COMMAND_LIMIT,
  boundedCommand,
  classifyDestructiveCommand,
  redactCommand,
  tokenizeShell
} from './destructive.ts';

test('recursive delete variants are recognised through wrappers and segments', () => {
  for (const command of [
    'rm -rf /tmp/build',
    'rm -fr /tmp/build',
    'rm -r -f /tmp/build',
    'rm -Rf /tmp/build',
    'rm --recursive --force /tmp/build',
    'sudo rm -rf /tmp/build',
    'sudo -u root rm -rf /tmp/build',
    'env FOO=1 rm -rf /tmp/build',
    'command rm -rf /tmp/build',
    'nohup rm -rf /tmp/build',
    'timeout 5 rm -rf /tmp/build',
    'xargs rm -rf',
    'echo done && rm -rf /tmp/build',
    'echo done; rm -rf /tmp/build',
    'bash -c "rm -rf /tmp/build"',
    'bash -lc "rm -rf /tmp/build"',
    'sh -c \'rm -rf /tmp/build\'',
    'powershell -Command "Remove-Item -Recurse -Force C:\\temp"',
    'cmd /c "rmdir /s /q C:\\temp"',
    'cmd /c "del /s /q C:\\temp\\*"',
    'find . -name "*.tmp" -exec rm -rf {} \\;'
  ]) {
    const match = classifyDestructiveCommand(command);
    assert.equal(match?.category, 'recursive-delete', command);
    assert.equal(match?.label, 'recursive delete', command);
    assert.match(match?.reason ?? '', /Recursive delete/);
  }
});

test('PowerShell Remove-Item and cmd recursive deletes need recurse and force/quiet', () => {
  for (const command of [
    'Remove-Item -Recurse -Force C:\\temp',
    'remove-item -force -recurse C:\\temp',
    'Remove-Item -Recurse:$true -Force:$true C:\\temp',
    'powershell "Remove-Item -Recurse -Force C:\\temp"',
    'pwsh -NoProfile "Remove-Item -Recurse -Force C:\\temp"',
    'powershell -NoProfile -ExecutionPolicy Bypass "Remove-Item -Recurse -Force C:\\temp"',
    'rmdir /s /q C:\\temp',
    'rmdir /S/Q C:\\temp',
    'rd /S /Q C:\\temp',
    'del /s /q C:\\temp\\*',
    'del /s/q C:\\temp\\*',
    'erase /S /Q C:\\temp\\*'
  ]) {
    assert.equal(classifyDestructiveCommand(command)?.category, 'recursive-delete', command);
  }
  assert.equal(classifyDestructiveCommand('Remove-Item -Recurse C:\\temp'), undefined);
  assert.equal(classifyDestructiveCommand('Remove-Item -Force C:\\temp'), undefined);
  assert.equal(classifyDestructiveCommand('rmdir /s C:\\temp'), undefined);
  assert.equal(classifyDestructiveCommand('del /s C:\\temp\\*'), undefined);
  assert.equal(classifyDestructiveCommand('del C:\\temp\\file.txt'), undefined);
});

test('a recursive or forced delete alone is not destructive', () => {
  assert.equal(classifyDestructiveCommand('rm -r /tmp/build'), undefined);
  assert.equal(classifyDestructiveCommand('rm -f /tmp/build'), undefined);
  assert.equal(classifyDestructiveCommand('echo "rm -rf /tmp/build"'), undefined);
});

test('force push variants are recognised, including value flags and global git options', () => {
  for (const command of [
    'git push --force',
    'git push -f origin main',
    'git push -uf origin main',
    'git push --force-with-lease',
    'git push --force-with-lease=origin/main',
    'git push --force-if-includes',
    'git push --force-if-includes=abc123',
    'git -C repo push --force',
    'git -c user.name=x push -f',
    'git push origin +main',
    'git push origin +refs/heads/main:refs/heads/main',
    'git push --delete origin old-branch',
    'git push -d origin old-branch',
    'git push origin :old-branch',
    'sudo git push --force'
  ]) {
    const match = classifyDestructiveCommand(command);
    assert.equal(match?.category, 'force-push', command);
    assert.equal(match?.label, 'force push', command);
    assert.match(match?.reason ?? '', /Force push/);
  }
  assert.equal(classifyDestructiveCommand('git push origin main'), undefined);
  assert.equal(classifyDestructiveCommand('git push --follow-tags'), undefined);
});

test('hard reset is recognised but an ordinary reset is not', () => {
  for (const command of ['git reset --hard', 'git reset --hard HEAD~1', 'git -C repo reset --hard']) {
    const match = classifyDestructiveCommand(command);
    assert.equal(match?.category, 'hard-reset', command);
    assert.equal(match?.label, 'hard reset', command);
  }
  assert.equal(classifyDestructiveCommand('git reset HEAD file.ts'), undefined);
});

test('database drops are found only in DB-client segments', () => {
  for (const command of [
    'psql -c "DROP TABLE users;"',
    "psql -c 'drop database app;'",
    'mysql -e "DROP DATABASE app"',
    'mariadb -e "DROP DATABASE app"',
    'sqlite3 app.db "DROP TABLE users"',
    'sqlcmd -Q "DROP TABLE users"',
    'clickhouse-client --query "DROP TABLE events"',
    'sqlplus user/pass@db @drop.sql "DROP DATABASE app"',
    'prisma db execute --stdin "DROP TABLE users"',
    'mongosh --eval "db.dropDatabase()"',
    'mongosh --eval "db.dropDatabase ( )"',
    "mongosh --eval 'db.getSiblingDB(\"app\").dropDatabase()'"
  ]) {
    const match = classifyDestructiveCommand(command);
    assert.equal(match?.category, 'database-drop', command);
    assert.equal(match?.label, 'database drop', command);
  }
  assert.equal(classifyDestructiveCommand('psql -c "SELECT * FROM users"'), undefined);
});

test('a DROP string outside a DB-client segment is not a database drop', () => {
  for (const command of [
    'git commit -m "DROP TABLE users"',
    'grep "DROP TABLE" schema.sql',
    'echo "DROP DATABASE app"',
    'node -e "console.log(\'DROP TABLE users\')"',
    'cat migration.sql | grep "DROP TABLE"'
  ]) {
    assert.equal(classifyDestructiveCommand(command), undefined, command);
  }
});

test('common password and token values are redacted from the risk reason', () => {
  const cases = [
    ['mysql -uroot -psecret -e "DROP DATABASE app"', 'secret'],
    ['mysql -uroot -p secret -e "DROP DATABASE app"', 'secret'],
    ['mysql --password=supersecret -e "DROP TABLE users"', 'supersecret'],
    ['mysql --password supersecret -e "DROP TABLE users"', 'supersecret'],
    ['psql --token abc123 -c "DROP TABLE users"', 'abc123'],
    ['psql --api-key=keyvalue -c "DROP TABLE users"', 'keyvalue'],
    ['psql --secret secretvalue -c "DROP TABLE users"', 'secretvalue'],
    ['PASSWORD=hunter2 psql -c "DROP TABLE users"', 'hunter2'],
    ['TOKEN=tokvalue psql -c "DROP TABLE users"', 'tokvalue']
  ] as const;
  for (const [command, credential] of cases) {
    const match = classifyDestructiveCommand(command);
    assert.ok(match, command);
    assert.equal(match.category, 'database-drop', command);
    assert.equal(match.reason.includes(credential), false, command);
    assert.match(match.reason, /<redacted>/, command);
  }
  assert.equal(redactCommand('mysql -uroot -psecret db'), 'mysql -uroot -p<redacted> db');
  assert.equal(redactCommand('APP_PASSWORD=hunter2 run'), 'APP_PASSWORD=<redacted> run');
  assert.equal(redactCommand('echo --api-key=abc'), 'echo --api-key=<redacted>');
});

test('custom patterns match commands, and invalid or blank patterns are ignored safely', () => {
  const match = classifyDestructiveCommand('kubectl delete namespace prod', ['kubectl\\s+delete']);
  assert.equal(match?.category, 'custom');
  assert.equal(match?.label, 'custom destructive pattern');
  assert.match(match?.reason ?? '', /kubectl delete namespace prod/);

  assert.equal(classifyDestructiveCommand('terraform destroy', [new RegExp('terraform\\s+destroy', 'i')])?.category, 'custom');
  assert.equal(classifyDestructiveCommand('terraform destroy', ['(']), undefined);
  assert.equal(classifyDestructiveCommand('terraform destroy', ['   ']), undefined);
  assert.equal(classifyDestructiveCommand('safe command', ['kubectl\\s+delete']), undefined);
});

test('the reason carries the exact command and is bounded to one line', () => {
  const command = `psql -c "DROP TABLE ${'x'.repeat(400)}"`;
  const match = classifyDestructiveCommand(command);
  assert.ok(match);
  assert.match(match.reason, /^Database drop: /);
  assert.equal(match.reason.includes('\n'), false);
  assert.equal(match.reason.length <= 'Database drop: '.length + PROMPT_COMMAND_LIMIT, true);
  assert.match(match.reason, /\u2026$/);
  assert.equal(boundedCommand('  git   push  --force \n origin '), 'git push --force origin');
});

test('tokenisation keeps quoted groups and splits shell operators', () => {
  assert.deepEqual(tokenizeShell('git -C repo push --force'), [['git', '-C', 'repo', 'push', '--force']]);
  assert.deepEqual(tokenizeShell('echo "a && b"; rm -rf x'), [
    ['echo', 'a && b'],
    ['rm', '-rf', 'x']
  ]);
  assert.deepEqual(tokenizeShell('cat file | xargs rm -rf'), [
    ['cat', 'file'],
    ['xargs', 'rm', '-rf']
  ]);
});
