import test from 'node:test';
import assert from 'node:assert/strict';
import { skillCliPathError } from './skillCli.ts';

/**
 * The skill CLI path rule.
 *
 * The `zg` and `ast-grep` binaries are spawned with the workspace as their
 * working directory, so a value that names a file inside the repository would
 * run that file. The rule is the shared one: a bare command name is left for
 * PATH, an absolute path is used as-is, and everything else is refused.
 *
 * The rule is host-free, so it is unit-tested here rather than through the
 * extension host — and every write of a skill path (the settings save and
 * the skill toggle) uses this one function.
 */

test('a bare command name is accepted', () => {
  assert.equal(skillCliPathError('zg', 'zg', 'zg CLI'), undefined);
  assert.equal(skillCliPathError('ast-grep', 'ast-grep', 'ast-grep CLI'), undefined);
});

test('an absolute path is accepted', () => {
  assert.equal(skillCliPathError('/usr/local/bin/zg', 'zg', 'zg CLI'), undefined);
  assert.equal(skillCliPathError('C:\\Tools\\zg.exe', 'zg', 'zg CLI'), undefined);
  assert.equal(skillCliPathError('\\\\server\\share\\zg.exe', 'zg', 'zg CLI'), undefined);
});

test('a relative path with a separator is refused', () => {
  for (const value of ['./evil', '..\\evil', 'bin/zg', 'sub\\zg.exe', '.\\evil']) {
    const message = skillCliPathError(value, 'zg', 'zg CLI');
    assert.ok(message, value);
    assert.match(message as string, /absolute path or a command name/, value);
    assert.match(message as string, /not saved/, value);
  }
});

test('a Windows drive-relative path is refused', () => {
  // `C:evil.exe` carries no separator, so only the drive-relative rule
  // catches it: Windows resolves it against the current directory of that
  // drive, which for a spawned child is the workspace.
  for (const value of ['C:evil.exe', 'c:evil.exe', 'C:', 'C:..\\evil']) {
    const message = skillCliPathError(value, 'zg', 'zg CLI');
    assert.ok(message, value);
    assert.match(message as string, /absolute path or a command name/, value);
    assert.match(message as string, /not saved/, value);
  }
});

test('an empty value is refused with a message that names the field', () => {
  const message = skillCliPathError('   ', 'zg', 'zg CLI');
  assert.ok(message);
  assert.match(message as string, /zg CLI/);
  assert.match(message as string, /not saved/);
});
