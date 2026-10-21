/**
 * Screenshot files are local artifacts under the workspace, never committed.
 * Host-free so the naming and write path can be tested without VS Code.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const SCREENSHOT_DIRECTORY = ['.melink', 'reports', 'browser'] as const;

/** The directory a workspace writes screenshots into. */
export function screenshotDirectory(root: string): string {
  return resolve(root, ...SCREENSHOT_DIRECTORY);
}

/** A filename fragment: lowercase letters, digits, and single dashes. */
export function sanitizeScreenshotPart(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

/**
 * The readable part of the name: a title, else the URL host. Query strings and
 * fragments are dropped, so a token in a URL never reaches the filename.
 */
export function screenshotBaseName(title: string, url: string): string {
  const titlePart = sanitizeScreenshotPart(title.split(/[?#]/, 1)[0] ?? '');
  if (titlePart) {
    return titlePart;
  }
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    host = '';
  }
  return sanitizeScreenshotPart(host) || 'screenshot';
}

/** Sortable and safe on Windows: YYYYMMDD-HHmmss-SSS. */
export function screenshotTimestamp(date: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return [
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`
  ].join('-');
}

/** Throws the exact message the tool shows when no workspace is open. */
export function requireWorkspaceRoot(root: string | undefined): string {
  if (!root) {
    throw new Error('No workspace folder is open, so the screenshot cannot be saved.');
  }
  return root;
}

/**
 * Write a PNG under `<root>/.melink/reports/browser/`. The directory is created
 * on demand and a counter keeps names unique even inside one millisecond.
 */
export async function saveScreenshot(
  root: string,
  pngBase64: string,
  title: string,
  url: string,
  now: Date = new Date()
): Promise<string> {
  const directory = screenshotDirectory(root);
  await mkdir(directory, { recursive: true });
  const stamp = screenshotTimestamp(now);
  const base = screenshotBaseName(title, url);
  const bytes = Buffer.from(pngBase64, 'base64');
  for (let counter = 1; counter <= 1_000; counter += 1) {
    const name = `${stamp}-${String(counter).padStart(3, '0')}-${base}.png`;
    const path = join(directory, name);
    try {
      await writeFile(path, bytes, { flag: 'wx' });
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        continue;
      }
      throw error;
    }
  }
  throw new Error('Could not find a unique screenshot file name.');
}
