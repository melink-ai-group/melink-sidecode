/** Tool descriptors the ast-grep MCP shim exposes to OpenCode. */

export const AST_GREP_TOOLS = [
  {
    name: 'search',
    description:
      'Syntax-aware structural search with an ast-grep pattern. Prefer this over text grep when matching code by AST shape.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'ast-grep pattern (code shape, not regex)' },
        lang: { type: 'string', description: 'Language id (e.g. typescript, python, go)' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files or directories to search (defaults to the workspace)'
        },
        globs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Include/exclude globs'
        },
        context: { type: 'number', description: 'Context lines around each match' }
      },
      required: ['pattern'],
      additionalProperties: false
    }
  },
  {
    name: 'replace',
    description:
      'Syntax-aware rewrite with ast-grep. Defaults to dry-run (preview). To apply, pass approve: true and explicit paths inside the workspace; a bare --update-all over the whole workspace is never run.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'ast-grep pattern to match' },
        rewrite: { type: 'string', description: 'Replacement pattern' },
        lang: { type: 'string', description: 'Language id' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files or directories, relative to the workspace (required when dryRun is false)'
        },
        globs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Include/exclude globs, relative to the workspace'
        },
        dryRun: {
          type: 'boolean',
          description: 'When true (default), preview without writing files'
        },
        approve: {
          type: 'boolean',
          description: 'Required to be true when dryRun is false: confirms writing the named paths'
        }
      },
      required: ['pattern', 'rewrite'],
      additionalProperties: false
    }
  }
] as const;
