import type { PermissionLevel } from './types';
import type { AskForApproval } from '../../schemas/v2/AskForApproval';
import type { SandboxMode } from '../../schemas/v2/SandboxMode';
import type { SandboxPolicy } from '../../schemas/v2/SandboxPolicy';
import type { AbsolutePathBuf } from '../../schemas/AbsolutePathBuf';

/**
 * The one place the shared `PermissionLevel` is translated into Codex's own
 * vocabulary. Both values are taken straight from the generated types
 * (`AskForApproval`, `SandboxMode`) — there is no parallel vocabulary here and
 * no string this module invents that the CLI does not accept.
 *
 * The two axes are deliberately separate and must not be conflated:
 *
 * - `sandbox` is enforced by Codex *outside the model*. It is the safety net.
 * - `approvalPolicy` governs *when the user is asked*. It is not a sandbox.
 *
 * Mapping:
 *
 * | Level          | sandbox             | approvalPolicy |
 * |----------------|---------------------|----------------|
 * | `read-only`    | `read-only`         | `on-request`   |
 * | `default`      | `workspace-write`   | `on-request`   |
 * | `unrestricted` | `danger-full-access`| `never`        |
 *
 * `on-request` is used for the two sandboxed levels rather than the older
 * `untrusted` policy: `untrusted` is a documented-but-deprecated spelling that
 * only prompts on untrusted commands, so building on it would silently widen
 * what runs without a prompt. `never` is intentional only for `unrestricted`,
 * which is gated behind the labelled confirmation in the UI.
 */
export interface CodexPermissionMapping {
  sandbox: SandboxMode;
  approvalPolicy: AskForApproval;
}

export const CODEX_PERMISSION_MAP: Readonly<Record<PermissionLevel, CodexPermissionMapping>> = {
  'read-only': { sandbox: 'read-only', approvalPolicy: 'on-request' },
  default: { sandbox: 'workspace-write', approvalPolicy: 'on-request' },
  unrestricted: { sandbox: 'danger-full-access', approvalPolicy: 'never' }
};

/** The level a thread runs at when none was chosen. */
export const DEFAULT_PERMISSION_LEVEL: PermissionLevel = 'default';

/** Map a level to Codex's native `sandbox` + `approvalPolicy` pair. */
export function codexPermissionMapping(level: PermissionLevel): CodexPermissionMapping {
  return CODEX_PERMISSION_MAP[level] ?? CODEX_PERMISSION_MAP[DEFAULT_PERMISSION_LEVEL];
}

/**
 * The richer `SandboxPolicy` a turn can override with. Uses the same three axes
 * as the mapping above, so a level change made mid-conversation cannot drift
 * from the level the user picked.
 */
export function codexSandboxPolicy(level: PermissionLevel, root: string): SandboxPolicy {
  switch (level) {
    case 'read-only':
      return { type: 'readOnly', networkAccess: false };
    case 'unrestricted':
      return { type: 'dangerFullAccess' };
    case 'default':
    default:
      return {
        type: 'workspaceWrite',
        writableRoots: [root as AbsolutePathBuf],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false
      };
  }
}

/** Presentation for each level. One source of truth for the picker copy. */
export interface PermissionLevelDescriptor {
  level: PermissionLevel;
  label: string;
  description: string;
  /**
   * True for a level that widens permissions beyond a sandbox: choosing it
   * removes the prompt, so it must not be selectable without a labelled
   * confirmation.
   */
  requiresConfirmation: boolean;
}

export const PERMISSION_LEVEL_DESCRIPTORS: readonly PermissionLevelDescriptor[] = [
  {
    level: 'read-only',
    label: 'Read-only',
    description: 'Codex runs read-only. Anything that would write is requested.',
    requiresConfirmation: false
  },
  {
    level: 'default',
    label: 'Default',
    description: 'Codex runs workspace-write and asks before anything outside the sandbox.',
    requiresConfirmation: false
  },
  {
    level: 'unrestricted',
    label: 'Unrestricted',
    description: 'No sandbox and no prompts. Codex acts without asking.',
    requiresConfirmation: true
  }
];

/** The descriptor for a level, defaulting to the safe `default` level's copy. */
export function permissionDescriptor(level: PermissionLevel): PermissionLevelDescriptor {
  return (
    PERMISSION_LEVEL_DESCRIPTORS.find((entry) => entry.level === level) ?? PERMISSION_LEVEL_DESCRIPTORS[1]
  );
}
