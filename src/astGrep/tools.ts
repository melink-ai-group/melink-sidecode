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
      'Syntax-aware rewrite with ast-grep. Defaults to dry-run (preview). Set dryRun false to apply.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'ast-grep pattern to match' },
        rewrite: { type: 'string', description: 'Replacement pattern' },
        lang: { type: 'string', description: 'Language id' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files or directories'
        },
        globs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Include/exclude globs'
        },
        dryRun: {
          type: 'boolean',
          description: 'When true (default), preview without writing files'
        }
      },
      required: ['pattern', 'rewrite'],
      additionalProperties: false
    }
  }
] as const;
