import { createId } from '../base';
import type { ApprovalDecision, ApprovalRequest } from '../types';
import type { CommandExecutionRequestApprovalParams } from '../../../schemas/v2/CommandExecutionRequestApprovalParams';
import type { CommandExecutionApprovalDecision } from '../../../schemas/v2/CommandExecutionApprovalDecision';
import type { FileChangeRequestApprovalParams } from '../../../schemas/v2/FileChangeRequestApprovalParams';
import type { FileChangeApprovalDecision } from '../../../schemas/v2/FileChangeApprovalDecision';
import type { PermissionsRequestApprovalParams } from '../../../schemas/v2/PermissionsRequestApprovalParams';
import type { PermissionsRequestApprovalResponse } from '../../../schemas/v2/PermissionsRequestApprovalResponse';
import type { RequestPermissionProfile } from '../../../schemas/v2/RequestPermissionProfile';
import type { GrantedPermissionProfile } from '../../../schemas/v2/GrantedPermissionProfile';
import type { ExecCommandApprovalParams } from '../../../schemas/ExecCommandApprovalParams';
import type { ApplyPatchApprovalParams } from '../../../schemas/ApplyPatchApprovalParams';
import type { ReviewDecision } from '../../../schemas/ReviewDecision';

/**
 * Translate the app-server's approval server requests into the provider-neutral
 * `ApprovalRequest` shape, and the user's decision back into the exact native
 * decision each method expects. Kept pure and free of the transport so the
 * mapping is unit-testable and protocol drift shows up as a type error.
 *
 * Both the current request methods (`item/commandExecution/requestApproval`,
 * `item/fileChange/requestApproval`, `item/permissions/requestApproval`) and the
 * legacy `execCommandApproval` / `applyPatchApproval` methods are handled, since
 * a newer server may still send either. The permission *level* mapping is built
 * only on the current `AskForApproval` / `SandboxMode` values; nothing here
 * relies on a deprecated policy value.
 */

/** Methods whose params carry the v2 `threadId` / `turnId` fields. */
export type ApprovalMethod =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'item/permissions/requestApproval'
  | 'execCommandApproval'
  | 'applyPatchApproval';

/** Build a neutral request from any supported approval method's params. */
export function translateApprovalRequest(
  method: string,
  params: unknown,
  origin: string
): { threadId: string; request: ApprovalRequest } | undefined {
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      const typed = params as CommandExecutionRequestApprovalParams;
      return { threadId: typed.threadId, request: commandRequest(typed, origin) };
    }
    case 'item/fileChange/requestApproval': {
      const typed = params as FileChangeRequestApprovalParams;
      return { threadId: typed.threadId, request: fileChangeRequest(typed, origin) };
    }
    case 'item/permissions/requestApproval': {
      const typed = params as PermissionsRequestApprovalParams;
      return { threadId: typed.threadId, request: permissionsRequest(typed, origin) };
    }
    case 'execCommandApproval': {
      const typed = params as ExecCommandApprovalParams;
      return { threadId: legacyThreadId(typed.conversationId, origin), request: legacyCommandRequest(typed, origin) };
    }
    case 'applyPatchApproval': {
      const typed = params as ApplyPatchApprovalParams;
      return { threadId: legacyThreadId(typed.conversationId, origin), request: legacyPatchRequest(typed, origin) };
    }
    default:
      return undefined;
  }
}

function commandRequest(params: CommandExecutionRequestApprovalParams, origin: string): ApprovalRequest {
  return {
    id: createId('approval'),
    kind: 'command',
    method: 'item/commandExecution/requestApproval',
    command: params.command ?? undefined,
    cwd: params.cwd ?? undefined,
    reason: params.reason ?? undefined,
    network: params.networkApprovalContext?.host,
    execPolicyAmendment: params.proposedExecpolicyAmendment ?? undefined,
    origin
  };
}

function fileChangeRequest(params: FileChangeRequestApprovalParams, origin: string): ApprovalRequest {
  const paths = pathsFromGrantRoot(params.grantRoot);
  return {
    id: createId('approval'),
    kind: 'file-change',
    method: 'item/fileChange/requestApproval',
    paths,
    reason: params.reason ?? undefined,
    grantRoot: params.grantRoot ?? undefined,
    origin
  };
}

function permissionsRequest(params: PermissionsRequestApprovalParams, origin: string): ApprovalRequest {
  return {
    id: createId('approval'),
    kind: 'permissions',
    method: 'item/permissions/requestApproval',
    reason: params.reason ?? undefined,
    origin: params.cwd ?? origin
  };
}

function legacyCommandRequest(params: ExecCommandApprovalParams, origin: string): ApprovalRequest {
  return {
    id: createId('approval'),
    kind: 'command',
    method: 'execCommandApproval',
    command: params.command.join(' '),
    cwd: params.cwd,
    reason: params.reason ?? undefined,
    origin
  };
}

function legacyPatchRequest(params: ApplyPatchApprovalParams, origin: string): ApprovalRequest {
  const paths = Object.keys(params.fileChanges ?? {});
  return {
    id: createId('approval'),
    kind: 'file-change',
    method: 'applyPatchApproval',
    paths,
    reason: params.reason ?? undefined,
    grantRoot: params.grantRoot ?? undefined,
    origin
  };
}

/** A v2 request that never reported a thread falls back to the origin thread. */
function legacyThreadId(conversationId: string, origin: string): string {
  return conversationId || origin;
}

function pathsFromGrantRoot(grantRoot: string | null | undefined): string[] {
  return grantRoot ? [grantRoot] : [];
}

/**
 * The native response for a decision on a command approval. `always` uses the
 * server's own proposed exec-policy amendment when it offered one; otherwise it
 * is answered as a single accept and the lasting rule is enforced by our stored
 * rule, so nothing is claimed to the server that it cannot honor.
 */
export function commandDecision(
  request: ApprovalRequest,
  decision: ApprovalDecision
): CommandExecutionApprovalDecision {
  switch (decision) {
    case 'allow-session':
      return 'acceptForSession';
    case 'allow-always':
      if (request.execPolicyAmendment && request.execPolicyAmendment.length > 0) {
        return { acceptWithExecpolicyAmendment: { execpolicy_amendment: request.execPolicyAmendment } };
      }
      return 'accept';
    case 'reject':
      return 'decline';
    case 'allow-once':
    default:
      return 'accept';
  }
}

/** The native response for a decision on a file-change approval. */
export function fileChangeDecision(_request: ApprovalRequest, decision: ApprovalDecision): FileChangeApprovalDecision {
  switch (decision) {
    case 'allow-session':
      return 'acceptForSession';
    case 'reject':
      return 'decline';
    case 'allow-always':
    case 'allow-once':
    default:
      // The native vocabulary has no lasting accept, so `always` is answered as
      // a single accept here and remembered by our own stored rule.
      return 'accept';
  }
}

/** The legacy `ReviewDecision` for an old-style approval method. */
export function legacyReviewDecision(
  request: ApprovalRequest,
  decision: ApprovalDecision,
  rejection: string
): ReviewDecision {
  switch (decision) {
    case 'allow-session':
      return 'approved_for_session';
    case 'allow-always':
      if (request.execPolicyAmendment && request.execPolicyAmendment.length > 0) {
        return {
          approved_execpolicy_amendment: { proposed_execpolicy_amendment: request.execPolicyAmendment }
        };
      }
      return 'approved';
    case 'reject':
      return { denied: { rejection } };
    case 'allow-once':
    default:
      return 'approved';
  }
}

/**
 * The response to a permissions request. A rejection grants nothing; an allow
 * echoes exactly the requested permission profile, scoped to the turn for
 * `allow-once` and to the session otherwise. `always` is honored by our own
 * stored rule as well, so it survives a reload.
 */
export function permissionsResponse(
  profile: RequestPermissionProfile,
  decision: ApprovalDecision
): PermissionsRequestApprovalResponse {
  if (decision === 'reject') {
    return { permissions: {}, scope: 'turn' };
  }
  return {
    permissions: grantProfile(profile),
    scope: decision === 'allow-once' ? 'turn' : 'session'
  };
}

/**
 * Convert a requested permission profile into the granted shape: the generated
 * `GrantedPermissionProfile` uses optional (not nullable) members, and granting
 * exactly what was asked for is the only honest mapping.
 */
function grantProfile(profile: RequestPermissionProfile): GrantedPermissionProfile {
  const granted: GrantedPermissionProfile = {};
  if (profile.network) {
    granted.network = profile.network;
  }
  if (profile.fileSystem) {
    granted.fileSystem = profile.fileSystem;
  }
  return granted;
}

/** A short, honest sentence describing a request, used on its transcript card. */
export function approvalSummary(request: ApprovalRequest): string {
  switch (request.kind) {
    case 'command':
      return request.command ? `Run: ${request.command}` : 'Run a command';
    case 'file-change':
      return request.paths && request.paths.length > 0
        ? `Change files under ${request.paths.join(', ')}`
        : 'Apply file changes';
    case 'permissions':
      return 'Grant extra permissions';
    default:
      return 'Continue';
  }
}
