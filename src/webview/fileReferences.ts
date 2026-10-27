/**
 * Recognise a file reference in chat output.
 *
 * The transcript shows inline code and link targets. Only values that look like
 * a project file become clickable, so ordinary code such as `useState` or a
 * command such as `npm test` keeps its plain rendering. A reference may carry a
 * trailing `:line` or `:line:column`, which the host uses to place the caret.
 */

export interface FileReference {
  path: string;
  /** 1-based line from `path:line` or `path:line:column`. */
  line?: number;
  column?: number;
}

/** Extensions that are almost always a file, never a sentence or a version. */
const FILE_EXTENSIONS = new Set([
  'astro',
  'bash',
  'bat',
  'c',
  'cc',
  'cfg',
  'cjs',
  'cmd',
  'conf',
  'config',
  'cpp',
  'cs',
  'css',
  'csv',
  'cxx',
  'dockerfile',
  'editorconfig',
  'env',
  'fish',
  'gif',
  'gitattributes',
  'gitignore',
  'go',
  'gql',
  'graphql',
  'h',
  'hh',
  'hpp',
  'htm',
  'html',
  'hxx',
  'ico',
  'ini',
  'java',
  'jpeg',
  'jpg',
  'js',
  'json',
  'json5',
  'jsonc',
  'jsx',
  'kt',
  'kts',
  'less',
  'lock',
  'log',
  'm',
  'md',
  'mdx',
  'mjs',
  'mm',
  'npmrc',
  'pdf',
  'php',
  'png',
  'proto',
  'ps1',
  'py',
  'pyi',
  'rb',
  'rs',
  'sass',
  'scss',
  'sh',
  'sql',
  'svelte',
  'svg',
  'swift',
  'toml',
  'ts',
  'tsv',
  'tsx',
  'txt',
  'vue',
  'webp',
  'xml',
  'yaml',
  'yml',
  'zsh'
]);

/** Files without an extension that still read as a path. */
const NAMED_FILES = new Set([
  'cmakelists.txt',
  'dockerfile',
  'gemfile',
  'makefile',
  'procfile',
  'rakefile'
]);

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const LINE_SUFFIX = /^(.*?)(?::(\d+))(?::(\d+))?$/;
const WITH_EXTENSION = /\.([A-Za-z0-9]{1,12})$/;
const MAX_LENGTH = 260;

/** Parse one candidate; undefined means "render it as ordinary text". */
export function parseFileReference(value: string): FileReference | undefined {
  const text = value.trim();
  if (!text || text.length > MAX_LENGTH || /\s/.test(text)) {
    return undefined;
  }
  if (text.startsWith('#') || text.startsWith('//') || text.includes('://')) {
    return undefined;
  }
  const drive = DRIVE_PATH.test(text);
  if (!drive && SCHEME.test(text)) {
    return undefined;
  }
  const suffix = LINE_SUFFIX.exec(text);
  const file = suffix ? suffix[1] : text;
  if (!file || file.endsWith('/') || file.endsWith('\\')) {
    return undefined;
  }
  const name = file.split(/[\\/]/).pop() ?? '';
  if (!isFileName(name)) {
    return undefined;
  }
  const line = suffix?.[2] ? Number(suffix[2]) : undefined;
  const column = suffix?.[3] ? Number(suffix[3]) : undefined;
  return {
    path: file,
    ...(line !== undefined && line > 0 ? { line } : {}),
    ...(column !== undefined && column > 0 ? { column } : {})
  };
}

function isFileName(name: string): boolean {
  if (!name || name === '.' || name === '..') {
    return false;
  }
  const lower = name.toLowerCase();
  if (NAMED_FILES.has(lower)) {
    return true;
  }
  const extension = WITH_EXTENSION.exec(name)?.[1]?.toLowerCase();
  return extension !== undefined && FILE_EXTENSIONS.has(extension);
}
