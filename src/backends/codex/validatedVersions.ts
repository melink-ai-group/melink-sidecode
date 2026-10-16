import { isSupportedCodexVersion, parseCodexVersion } from '../appserver/version.ts';

/** `globalState` key for exact Codex versions Validate version has allowed. */
export const VALIDATED_CODEX_VERSIONS_KEY = 'melink.codex.validatedVersions';

/** The slice of `vscode.Memento` this list needs. */
export interface VersionMemento {
  get<T>(key: string, fallback?: T): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/**
 * Keep only exact `major.minor.patch` versions that sit outside the built-in
 * window. Versions the window already covers are dropped, and junk is ignored.
 */
export function normalizeValidatedVersions(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const versions: string[] = [];
  for (const entry of value) {
    const parsed = typeof entry === 'string' ? parseCodexVersion(entry) : undefined;
    if (!parsed || seen.has(parsed.raw) || isSupportedCodexVersion(parsed)) {
      continue;
    }
    seen.add(parsed.raw);
    versions.push(parsed.raw);
  }
  return versions;
}

/** Add one validated version. A version already inside the built-in window is not stored. */
export function allowValidatedVersion(current: readonly string[], version: string): string[] {
  return normalizeValidatedVersions([...current, version]);
}

/** Persisted exact versions a Validate version run has allowed on this machine. */
export class ValidatedCodexVersions {
  private readonly state: VersionMemento;

  constructor(state: VersionMemento) {
    this.state = state;
  }

  list(): string[] {
    return normalizeValidatedVersions(this.state.get(VALIDATED_CODEX_VERSIONS_KEY, []));
  }

  async allow(version: string): Promise<string[]> {
    const next = allowValidatedVersion(this.list(), version);
    await this.state.update(VALIDATED_CODEX_VERSIONS_KEY, next);
    return next;
  }
}
