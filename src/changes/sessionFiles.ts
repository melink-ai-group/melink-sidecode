import type { ChangeSource } from '../backends/types';
import { hasIgnoredSegment } from './ignore.ts';
import type { JournalFileEntry, JournalTurn } from './journal.ts';

/**
 * The net file set for a thread, across every observed turn.
 *
 * A plan runs one turn per step. Each turn records only the paths it touched,
 * so the latest turn hides every earlier step. This folds those turns into the
 * change a reviewer actually has: one row per path, from the first pre-change
 * bytes to the latest result. A file a later step puts back is omitted.
 */

/** One path in the session, with where its baseline bytes live. */
export interface SessionFile {
  entry: JournalFileEntry;
  /**
   * The turn `getBefore(beforeTurnId, beforeRelPath)` reads for the session
   * baseline. Absent when the session created the file.
   */
  beforeTurnId?: string;
  /** The path that turn stored the baseline under. Absent when there is no baseline. */
  beforeRelPath?: string;
}

/** The session change set anchored on the turn the review surface should name. */
export interface SessionChangeSet {
  turnId: string;
  threadId: string;
  backendId: string;
  files: SessionFile[];
}

interface Acc {
  absPath: string;
  relPath: string;
  source: ChangeSource;
  beforeHash?: string;
  afterHash?: string;
  beforeKey?: string;
  afterKey?: string;
  hasBefore: boolean;
  hasAfter: boolean;
  sizeBytes: number;
  binary: boolean;
  inlineableBefore: boolean;
  inlineableAfter: boolean;
  renamedFrom?: string;
  beforeTurnId?: string;
  beforeRelPath?: string;
}

/**
 * Net the thread's observed turns.
 *
 * `turnsNewestFirst` is `listTurns` order. Returns `undefined` when nothing was
 * observed. An observed thread whose files net to nothing returns an empty
 * file list on the newest observed turn. A newer turn that observed nothing
 * does not erase earlier files, and it does not invent a verified empty set.
 */
export function sessionChangeSet(turnsNewestFirst: readonly JournalTurn[]): SessionChangeSet | undefined {
  if (turnsNewestFirst.length === 0) {
    return undefined;
  }
  const observed = turnsNewestFirst.filter((turn) => turn.observed);
  if (observed.length === 0) {
    return undefined;
  }
  const files = mergeSessionFiles([...observed].reverse());
  const newest = turnsNewestFirst[0];
  if (files.length === 0 && !newest.observed) {
    return undefined;
  }
  const anchor = newest.observed ? newest : observed[0];
  return {
    turnId: anchor.turnId,
    threadId: anchor.threadId,
    backendId: anchor.backendId,
    files
  };
}

/** Oldest-first observed turns, folded into one row per surviving path. */
export function mergeSessionFiles(turnsOldestFirst: readonly JournalTurn[]): SessionFile[] {
  const byPath = new Map<string, Acc>();
  const order: string[] = [];
  for (const turn of turnsOldestFirst) {
    for (const file of turn.files) {
      if (hasIgnoredSegment(file.relPath)) {
        continue;
      }
      const priorKey =
        file.renamedFrom && byPath.has(file.renamedFrom)
          ? file.renamedFrom
          : byPath.has(file.relPath)
            ? file.relPath
            : undefined;
      if (!priorKey) {
        const seeded = seed(file, turn.turnId);
        byPath.set(seeded.relPath, seeded);
        order.push(seeded.relPath);
        continue;
      }
      const next = evolve(byPath.get(priorKey) as Acc, file);
      byPath.delete(priorKey);
      const index = order.indexOf(priorKey);
      if (!next) {
        if (index >= 0) {
          order.splice(index, 1);
        }
        continue;
      }
      byPath.set(next.relPath, next);
      if (index >= 0) {
        order[index] = next.relPath;
      } else {
        order.push(next.relPath);
      }
    }
  }
  const files: SessionFile[] = [];
  for (const relPath of order) {
    const acc = byPath.get(relPath);
    if (!acc || !isNet(acc)) {
      continue;
    }
    files.push({
      entry: toEntry(acc),
      ...(acc.beforeTurnId ? { beforeTurnId: acc.beforeTurnId, beforeRelPath: acc.beforeRelPath } : {})
    });
  }
  return files;
}

function seed(file: JournalFileEntry, turnId: string): Acc {
  return {
    absPath: file.absPath,
    relPath: file.relPath,
    source: file.source,
    beforeHash: file.hasBefore ? file.beforeHash : undefined,
    afterHash: file.hasAfter ? file.afterHash : undefined,
    beforeKey: file.hasBefore ? file.beforeKey : undefined,
    afterKey: file.hasAfter ? file.afterKey : undefined,
    hasBefore: file.hasBefore,
    hasAfter: file.hasAfter,
    sizeBytes: file.sizeBytes,
    binary: file.binary,
    inlineableBefore: !file.hasBefore || Boolean(file.beforeKey),
    inlineableAfter: !file.hasAfter || Boolean(file.afterKey),
    renamedFrom: file.renamedFrom,
    beforeTurnId: file.hasBefore ? turnId : undefined,
    beforeRelPath: file.hasBefore ? file.relPath : undefined
  };
}

function evolve(prior: Acc, file: JournalFileEntry): Acc | undefined {
  const next: Acc = {
    ...prior,
    source: file.source === 'reported' || prior.source === 'reported' ? 'reported' : file.source,
    binary: prior.binary || file.binary
  };
  if (file.status === 'deleted') {
    next.hasAfter = false;
    next.afterHash = undefined;
    next.afterKey = undefined;
    next.inlineableAfter = true;
    return next.hasBefore ? next : undefined;
  }
  const pathChanged = file.relPath !== prior.relPath;
  next.absPath = file.absPath;
  next.relPath = file.relPath;
  next.hasAfter = file.hasAfter;
  next.afterHash = file.hasAfter ? file.afterHash : undefined;
  next.afterKey = file.hasAfter ? file.afterKey : undefined;
  next.sizeBytes = file.sizeBytes;
  next.inlineableAfter = !file.hasAfter || Boolean(file.afterKey);
  if (pathChanged && next.hasBefore) {
    next.renamedFrom = prior.renamedFrom ?? prior.relPath;
  }
  return isNet(next) ? next : undefined;
}

function isNet(acc: Acc): boolean {
  if (!acc.hasBefore && !acc.hasAfter) {
    return false;
  }
  if (
    acc.hasBefore &&
    acc.hasAfter &&
    acc.beforeHash !== undefined &&
    acc.beforeHash === acc.afterHash &&
    !acc.renamedFrom
  ) {
    return false;
  }
  return true;
}

function toEntry(acc: Acc): JournalFileEntry {
  const entry: JournalFileEntry = {
    absPath: acc.absPath,
    relPath: acc.relPath,
    status: !acc.hasAfter ? 'deleted' : !acc.hasBefore ? 'created' : acc.renamedFrom ? 'renamed' : 'modified',
    source: acc.source,
    sizeBytes: acc.sizeBytes,
    binary: acc.binary,
    inlineable: !acc.binary && acc.inlineableBefore && acc.inlineableAfter,
    hasBefore: acc.hasBefore,
    hasAfter: acc.hasAfter
  };
  if (acc.beforeHash !== undefined) {
    entry.beforeHash = acc.beforeHash;
  }
  if (acc.afterHash !== undefined) {
    entry.afterHash = acc.afterHash;
  }
  if (acc.beforeKey) {
    entry.beforeKey = acc.beforeKey;
  }
  if (acc.afterKey) {
    entry.afterKey = acc.afterKey;
  }
  if (acc.renamedFrom) {
    entry.renamedFrom = acc.renamedFrom;
  }
  return entry;
}
