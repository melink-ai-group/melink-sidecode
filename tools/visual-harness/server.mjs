/*
 * Local-only static server for the visual harness.
 *
 * The repository root is never served. Only the built bundle (`dist/`) and the
 * harness assets (`tools/visual-harness/`) are reachable; everything else
 * returns 404, including `.env`, `.git`, `node_modules`, `package.json`, and
 * path-traversal attempts.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

function hasUnsafeSegment(relative) {
  return relative
    .split(/[\\/]+/)
    .some((segment) => segment === '' || segment === '.' || segment === '..' || segment.startsWith('.') || segment === 'node_modules');
}

/**
 * Map a URL pathname to a file inside an allowed root, or return null.
 * `root` is the repository root; `harnessDir` defaults to this folder.
 */
export function resolveStaticTarget(pathname, root, harnessDir = HERE) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname || '/');
  } catch {
    return null;
  }
  if (decoded.includes('\0')) {
    return null;
  }
  const rootDir = path.resolve(root);
  const harnessRoot = path.resolve(harnessDir);
  const requested = decoded === '/' ? '/tools/visual-harness/index.html' : decoded;
  let base;
  let relative;
  if (requested.startsWith('/dist/')) {
    base = path.join(rootDir, 'dist');
    relative = requested.slice('/dist/'.length);
  } else if (requested.startsWith('/tools/visual-harness/')) {
    base = harnessRoot;
    relative = requested.slice('/tools/visual-harness/'.length);
  } else {
    return null;
  }
  if (hasUnsafeSegment(relative)) {
    return null;
  }
  const target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(base + path.sep)) {
    return null;
  }
  return target;
}

export function startStaticServer(root, harnessDir = HERE) {
  const server = createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end('method not allowed');
      return;
    }
    const target = resolveStaticTarget(new URL(request.url ?? '/', 'http://127.0.0.1').pathname, root, harnessDir);
    if (!target) {
      response.writeHead(404).end('not found');
      return;
    }
    try {
      const body = await readFile(target);
      response.writeHead(200, {
        'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
        'x-content-type-options': 'nosniff'
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}
