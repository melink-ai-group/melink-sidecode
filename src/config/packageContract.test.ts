import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TRUST_SCOPED_KEYS } from '../config/trust.ts';

/**
 * The package contract for the trust boundary.
 *
 * The contributed manifest is the first layer of the boundary: VS Code does
 * not offer an application-scoped setting in workspace settings at all. The
 * second layer is the code (the `inspect()` reads), but the two must agree:
 * a key the code treats as trust-sensitive but the manifest leaves
 * workspace-scoped would be readable from a repository, and a key the
 * manifest restricts but the code does not know about would silently stop
 * honouring the user's own setting.
 */

interface ContributedProperty {
  scope?: string;
  type?: string | string[];
  default?: unknown;
  enum?: unknown[];
  markdownDescription?: string;
  description?: string;
}

interface PackageManifest {
  capabilities?: {
    untrustedWorkspaces?: {
      supported?: boolean | 'limited';
      description?: string;
      restrictedConfigurations?: string[];
    };
  };
  contributes?: {
    configuration?: {
      properties?: Record<string, ContributedProperty>;
    };
  };
}

async function manifest(): Promise<PackageManifest> {
  const text = await readFile(join(process.cwd(), 'package.json'), 'utf8');
  return JSON.parse(text) as PackageManifest;
}

test('the manifest declares an untrusted-workspaces capability', async () => {
  const pkg = await manifest();
  const capability = pkg.capabilities?.untrustedWorkspaces;
  assert.ok(capability, 'capabilities.untrustedWorkspaces is missing');
  // `limited` is the honest answer: the extension works in an untrusted
  // workspace, but the sensitive settings are restricted.
  assert.equal(capability.supported, 'limited');
  assert.ok(capability.description && capability.description.length > 0);
});

test('the capability description names every trust-scoped key', async () => {
  const pkg = await manifest();
  const description = pkg.capabilities?.untrustedWorkspaces?.description ?? '';
  for (const key of TRUST_SCOPED_KEYS) {
    assert.ok(description.includes(key), `the capability description does not name ${key}`);
  }
});

test('every trust-scoped key is application-scoped in the manifest', async () => {
  const pkg = await manifest();
  const properties = pkg.contributes?.configuration?.properties ?? {};
  for (const key of TRUST_SCOPED_KEYS) {
    const property = properties[key];
    assert.ok(property, `${key} is not contributed`);
    assert.equal(property.scope, 'application', `${key} is not application-scoped`);
  }
});

test('no other contributed setting is application-scoped by accident', async () => {
  const pkg = await manifest();
  const properties = pkg.contributes?.configuration?.properties ?? {};
  const applicationScoped = Object.entries(properties)
    .filter(([, property]) => property.scope === 'application')
    .map(([key]) => key)
    .sort();
  assert.deepEqual(applicationScoped, [...TRUST_SCOPED_KEYS].sort());
});

test('the trust-scoped keys are exactly the ones the code protects', async () => {
  // The code and the manifest must name the same set, so a new sensitive
  // setting cannot be added to one and forgotten in the other.
  const pkg = await manifest();
  const properties = pkg.contributes?.configuration?.properties ?? {};
  const sensitive = Object.entries(properties)
    .filter(([key, property]) => {
      if (property.scope !== 'application') {
        return false;
      }
      return (
        key.endsWith('.baseUrl') ||
        key.endsWith('.path') ||
        key.endsWith('.cliSource') ||
        key.endsWith('.permissionLevel')
      );
    })
    .map(([key]) => key)
    .sort();
  assert.deepEqual(sensitive, [...TRUST_SCOPED_KEYS].sort());
});

/**
 * `restrictedConfigurations` tells VS Code not to hand the extension a
 * workspace-defined value for the listed settings while the workspace is
 * untrusted. It is a second, host-level layer on top of the application scope:
 * the code already ignores a workspace value for these keys, and this makes
 * the host do the same.
 */
test('the restricted configurations are the trust-scoped keys', async () => {
  const pkg = await manifest();
  const restricted = pkg.capabilities?.untrustedWorkspaces?.restrictedConfigurations;
  assert.ok(restricted, 'capabilities.untrustedWorkspaces.restrictedConfigurations is missing');
  assert.deepEqual([...restricted].sort(), [...TRUST_SCOPED_KEYS].sort());
});

test('the capability description states that the application scope is enforced', async () => {
  const pkg = await manifest();
  const description = pkg.capabilities?.untrustedWorkspaces?.description ?? '';
  assert.match(description, /application scope/i);
  assert.match(description, /enforced/i);
});
