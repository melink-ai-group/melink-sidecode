import { parseDiffReviewFindings, type DiffReviewFinding } from '../review/diffReview.ts';
import type { TranscriptItem } from '../backends/types.ts';

/** A malformed model reply must never be presented as a clean review. */
export function modelReviewFindings(text: string, paths: readonly string[]): DiffReviewFinding[] {
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed: unknown = JSON.parse(body);
  if (!Array.isArray(parsed) || parsed.some((entry) =>
    !entry || typeof entry !== 'object' || typeof entry.path !== 'string' ||
    !paths.includes(entry.path) || !Number.isInteger(entry.line) || entry.line < 1 ||
    !['error', 'warning', 'info'].includes(entry.severity) ||
    typeof entry.message !== 'string' || !entry.message.trim()
  )) {
    throw new Error('The reviewer returned invalid findings.');
  }
  return parseDiffReviewFindings(JSON.stringify(parsed));
}

export function reviewReferences(files: readonly { path: string; text: string }[]): string {
  return files.length === 0 ? '(no reference files available)' : files
    .map((file) => `--- ${file.path} ---\n${file.text.slice(0, 6000)}`)
    .join('\n\n').slice(0, 36_000);
}

/** Reserve room for comparison pages even when many files changed. */
export function selectReviewReferences(files: readonly string[], changedPaths: readonly string[]): string[] {
  const changed = new Set(changedPaths.map((file) => file.replace(/\\/g, '/')));
  const directory = (file: string): string => file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
  const directories = new Set([...changed].map(directory));
  const eligible = files.filter((file) => /\.(?:tsx?|jsx?|css|scss|html|vue|svelte|astro)$/.test(file));
  const neighbours = eligible.filter((file) => !changed.has(file) && directories.has(directory(file)));
  const shared = eligible.filter((file) => !changed.has(file) &&
    /(?:^|\/)(?:components|pages|views|routes)\//.test(file));
  shared.sort((a, b) => Number(/button|input|checkbox|textarea|select|form/i.test(b)) -
    Number(/button|input|checkbox|textarea|select|form/i.test(a)) || a.localeCompare(b));
  return [...new Set([...eligible.filter((file) => changed.has(file)).slice(0, 4),
    ...shared.slice(0, 4), ...neighbours.slice(0, 4), ...shared, ...neighbours])].slice(0, 12);
}

/** A worker cannot survive an extension-host restart; replay must say so. */
export function recoverSubagentActivities(items: readonly TranscriptItem[]): TranscriptItem[] {
  return items.map((item) => item.agentActivity && ['queued', 'running'].includes(item.agentActivity.status)
    ? { ...item, status: 'completed', agentActivity: { ...item.agentActivity, status: 'cancelled',
      detail: 'The worker stopped when the extension host restarted. Its result is unavailable.' } }
    : item);
}
