/*
 * Seeded host state for the visual harness.
 *
 * Every message below has the same shape the real extension host posts. The
 * harness sends them through `window.postMessage`, which is exactly the path a
 * real webview receives them on. No provider is contacted and no extension host
 * is started.
 */

const FIXED_SENT_AT = Date.UTC(2026, 9, 21, 9, 0, 0);
const FIXED_UPDATED_AT = Date.UTC(2026, 9, 21, 9, 5, 0);
const THREAD_ID = 'thread-visual';
const TURN_ID = 'turn-visual';

const CAPABILITIES = {
  contextWindow: { min: 8192, max: 131072, default: 32768 },
  thinking: { supported: ['low', 'medium', 'high'], default: 'medium' },
  tools: true,
  modes: ['agent', 'plan', 'ask']
};

const MODELS = {
  ollama: [
    {
      id: 'qwen3-coder:480b',
      label: 'qwen3-coder:480b',
      description: 'Agentic coding model with a large context window.',
      capabilities: CAPABILITIES
    },
    {
      id: 'kimi-k2:instruct',
      label: 'kimi-k2:instruct',
      description: 'General assistant with tool use.',
      capabilities: CAPABILITIES
    }
  ],
  'ollama-local': [
    {
      id: 'qwen2.5-coder:7b',
      label: 'qwen2.5-coder:7b',
      description: 'Local coding model.',
      capabilities: CAPABILITIES
    },
    {
      id: 'llama3.2:3b',
      label: 'llama3.2:3b',
      description: 'Small local assistant.',
      capabilities: CAPABILITIES
    }
  ],
  codex: [
    {
      id: 'gpt-5-codex',
      label: 'gpt-5-codex',
      description: 'Codex model for agentic edits.',
      capabilities: CAPABILITIES
    }
  ],
  opencode: [
    {
      id: 'big-pickle',
      label: 'big-pickle',
      description: 'Free OpenCode Zen model.',
      free: true,
      capabilities: CAPABILITIES
    }
  ]
};

const AVAILABILITY = [
  { id: 'ollama', label: 'Ollama Cloud', badge: 'Ollama', status: 'available' },
  { id: 'ollama-local', label: 'Ollama Local', badge: 'Ollama', status: 'available' },
  { id: 'codex', label: 'OpenAI Codex CLI', badge: 'Codex', status: 'available' },
  { id: 'opencode', label: 'OpenCode Zen', badge: 'Zen', status: 'available' }
];

const PERMISSIONS = {
  backendId: 'ollama',
  hasApprovalChannel: true,
  options: [
    {
      level: 'read-only',
      label: 'Read-only',
      description: 'Reads files; anything that writes is requested.',
      requiresConfirmation: false
    },
    {
      level: 'default',
      label: 'Default',
      description: 'Workspace writes and sandboxed commands run on their own.',
      requiresConfirmation: false
    },
    {
      level: 'unrestricted',
      label: 'Unrestricted',
      description: 'No sandbox and no prompts.',
      requiresConfirmation: true
    }
  ],
  selected: 'default',
  epoch: 1,
  rules: []
};

const MODES = {
  backendId: 'ollama',
  options: [
    { mode: 'agent', label: 'Agent', description: 'Act on the workspace.' },
    { mode: 'plan', label: 'Plan', description: 'Propose a plan before acting.' },
    { mode: 'ask', label: 'Ask', description: 'Answer questions only.' }
  ],
  selected: 'agent'
};

const CONTEXT_VIEW = {
  status: 'ready',
  workspaceName: 'melink-sidebar',
  branch: 'main',
  activeFile: 'src/webview/App.tsx',
  activeFilePath: 'C:\\work\\project\\src\\webview\\App.tsx',
  viewedFile: 'src/webview/App.tsx',
  viewedFilePath: 'C:\\work\\project\\src\\webview\\App.tsx',
  viewedFileIncluded: false,
  selectionLines: 0,
  categories: [
    {
      id: 'instructions',
      label: 'Instructions',
      count: 2,
      truncated: false,
      excluded: false,
      items: [
        { id: 'agents', label: 'AGENTS.md', excerpt: 'Project conventions', excluded: false },
        { id: 'readme', label: 'README.md', excerpt: 'Product overview', excluded: false }
      ]
    },
    {
      id: 'shape',
      label: 'Project shape',
      count: 3,
      truncated: false,
      excluded: false,
      items: [
        { id: 'lang', label: 'Languages', meta: 'TypeScript, CSS', excluded: false },
        { id: 'tree', label: 'Directory tree', meta: '14 entries', excluded: false },
        { id: 'manifest', label: 'package.json', excerpt: 'Scripts and dependencies', excluded: false }
      ]
    },
    {
      id: 'editor',
      label: 'Editor state',
      count: 1,
      truncated: false,
      excluded: false,
      items: [{ id: 'active', label: 'src/webview/App.tsx', meta: 'TypeScript', excluded: false }]
    },
    { id: 'selection', label: 'Selection', count: 0, truncated: false, excluded: false, items: [] },
    { id: 'changedFiles', label: 'Changed files', count: 0, truncated: false, excluded: false, items: [] }
  ],
  includedCount: 4,
  excludedCount: 0,
  remainingGroups: 2
};

function chatTab(title, threadId) {
  return {
    id: threadId ? `tab-${threadId}` : 'tab-new',
    title,
    active: true,
    backendId: 'ollama',
    ...(threadId ? { threadId } : {})
  };
}

function userItem(text, id = 'user-1') {
  return {
    id,
    kind: 'message',
    role: 'user',
    text,
    sentAt: FIXED_SENT_AT,
    status: 'completed'
  };
}

function assistantItem(text, id = 'assistant-1') {
  return {
    id,
    kind: 'message',
    role: 'assistant',
    title: 'qwen3-coder:480b',
    text,
    status: 'completed'
  };
}

function settingsSnapshot() {
  const localProbe = { path: 'opencode', status: 'detected', version: '1.1.65' };
  const bundledProbe = {
    path: 'C:\\Users\\visual\\AppData\\Roaming\\Code\\User\\globalStorage\\melink.\\opencode\\opencode.exe',
    status: 'missing'
  };
  return {
    target: 'global',
    ollama: {
      baseUrl: 'https://ollama.com',
      defaultModel: 'qwen3-coder:480b',
      hasToken: true,
      status: 'available'
    },
    ollamaLocal: {
      baseUrl: 'http://localhost:11434',
      defaultModel: 'qwen2.5-coder:7b',
      status: 'available'
    },
    codex: {
      path: 'codex',
      defaultModel: 'gpt-5-codex',
      status: 'available',
      authMode: 'chatgpt'
    },
    opencodeZen: {
      defaultModel: 'big-pickle',
      hasToken: false,
      status: 'available',
      detail: 'Free models are available without a key.'
    },
    opencode: {
      cliSource: 'local',
      path: 'opencode',
      status: 'detected',
      version: '1.1.65',
      local: localProbe,
      bundled: bundledProbe,
      zvecGrep: { enabled: false, cli: 'missing' }
    },
    defaults: {
      permissionLevel: 'default',
      mode: 'agent',
      thinking: 'medium',
      dictationModel: ''
    },
    context: {
      includeInstructions: true,
      includeShape: true,
      includeEditorState: true,
      includeSelection: true,
      includeChangedFiles: true,
      maxBytes: 20480,
      defaultMaxBytes: 20480,
      minMaxBytes: 1024,
      maxMaxBytes: 204800,
      exclude: []
    },
    orchestration: {
      testing: true,
      reviewing: false,
      doubleCheck: true,
      quickTask: true,
      planning: true,
      legacyTesting: false,
      legacyReviewing: false
    },
    skills: {
      browserCodex: true,
      browserOpencode: true,
      zvecGrep: {
        enabled: false,
        cliSource: 'local',
        path: 'zg',
        status: 'missing',
        local: { path: 'zg', status: 'missing' },
        bundled: bundledProbe,
        connected: false,
        cli: 'missing'
      },
      astGrep: {
        enabled: false,
        cliSource: 'local',
        path: 'ast-grep',
        status: 'missing',
        local: { path: 'ast-grep', status: 'missing' },
        bundled: bundledProbe,
        connected: false,
        cli: 'missing'
      }
    },
    models: MODELS
  };
}

function baseMessages({ title, threadId, model = 'qwen3-coder:480b', replay = [] }) {
  return [
    { type: 'snapshot', availability: AVAILABILITY },
    { type: 'models', backendId: 'ollama', models: MODELS.ollama },
    { type: 'models', backendId: 'ollama-local', models: MODELS['ollama-local'] },
    { type: 'models', backendId: 'codex', models: MODELS.codex },
    { type: 'models', backendId: 'opencode', models: MODELS.opencode },
    { type: 'settings', settings: settingsSnapshot() },
    {
      type: 'conversation',
      backendId: 'ollama',
      ...(threadId ? { threadId } : {}),
      model,
      permissionLevel: 'default',
      mode: 'agent',
      replay,
      hasOlderHistory: false
    },
    { type: 'restoring', value: false },
    { type: 'permissions', permissions: PERMISSIONS },
    { type: 'modes', modes: MODES },
    { type: 'context', view: CONTEXT_VIEW, settingsEnabled: true, exclusions: [], includeViewedFile: false, workspaceRoots: ['C:\\work\\project'] },
    { type: 'chatTabs', tabs: [chatTab(title, threadId)] }
  ];
}

export function screenMessages(slug) {
  switch (slug) {
    case 'chat-idle':
      return baseMessages({ title: 'New chat' });
    case 'stream-reasoning': {
      const messages = baseMessages({
        title: 'Refactor the auth guard',
        threadId: THREAD_ID,
        replay: [userItem('Refactor the auth guard and keep the audit log intact.')]
      });
      return [
        ...messages,
        {
          type: 'agentEvent',
          event: { type: 'turn/started', backendId: 'ollama', threadId: THREAD_ID, turnId: TURN_ID }
        },
        {
          type: 'agentEvent',
          event: {
            type: 'item/started',
            backendId: 'ollama',
            threadId: THREAD_ID,
            item: { id: 'reasoning-1', kind: 'reasoning', title: 'Reasoning' }
          }
        },
        {
          type: 'agentEvent',
          event: {
            type: 'item/delta',
            backendId: 'ollama',
            threadId: THREAD_ID,
            itemId: 'reasoning-1',
            delta:
              'The guard is duplicated in two middleware layers. I will move the check into one helper, keep the audit event order, and update the tests that assert both the allow and deny paths.'
          }
        },
        {
          type: 'agentEvent',
          event: {
            type: 'item/completed',
            backendId: 'ollama',
            threadId: THREAD_ID,
            itemId: 'reasoning-1',
            status: 'completed'
          }
        },
        {
          type: 'agentEvent',
          event: {
            type: 'item/started',
            backendId: 'ollama',
            threadId: THREAD_ID,
            item: {
              id: 'assistant-stream',
              kind: 'message',
              role: 'assistant',
              title: 'qwen3-coder:480b'
            }
          }
        },
        {
          type: 'agentEvent',
          event: {
            type: 'item/delta',
            backendId: 'ollama',
            threadId: THREAD_ID,
            itemId: 'assistant-stream',
            delta:
              'I found the duplicated check in `auth/middleware.ts` and `auth/session.ts`. First I will extract'
          }
        },
        {
          type: 'agentEvent',
          event: {
            type: 'context/usage',
            backendId: 'ollama',
            threadId: THREAD_ID,
            usedTokens: 6144,
            windowTokens: 32768
          }
        }
      ];
    }
    case 'change-review': {
      const messages = baseMessages({
        title: 'Refactor the auth guard',
        threadId: THREAD_ID,
        replay: [
          userItem('Refactor the auth guard and keep the audit log intact.'),
          assistantItem(
            'I extracted the guard into `requireSession`, reused it from both middleware layers, and added a regression test for the deny path.'
          )
        ]
      });
      return [
        ...messages,
        {
          type: 'changes/changed',
          backendId: 'ollama',
          threadId: THREAD_ID,
          turnId: TURN_ID,
          messageId: 'user-1',
          entries: [
            {
              absPath: 'C:\\work\\project\\src\\auth\\middleware.ts',
              path: 'src/auth/middleware.ts',
              status: 'modified',
              source: 'reported'
            },
            {
              absPath: 'C:\\work\\project\\src\\auth\\session.ts',
              path: 'src/auth/session.ts',
              status: 'modified',
              source: 'reported'
            },
            {
              absPath: 'C:\\work\\project\\src\\auth\\guard.test.ts',
              path: 'src/auth/guard.test.ts',
              status: 'created',
              source: 'reported'
            }
          ]
        },
        {
          type: 'changes/review',
          review: {
            backendId: 'ollama',
            threadId: THREAD_ID,
            turnId: TURN_ID,
            messageId: 'user-1',
            additions: 34,
            deletions: 18,
            fullyDecided: false,
            files: [
              {
                absPath: 'C:\\work\\project\\src\\auth\\middleware.ts',
                path: 'src/auth/middleware.ts',
                status: 'modified',
                source: 'reported',
                binary: false,
                diffable: true,
                additions: 8,
                deletions: 12,
                decision: 'pending',
                hunks: [],
                linesOmitted: true,
                restorable: true
              },
              {
                absPath: 'C:\\work\\project\\src\\auth\\session.ts',
                path: 'src/auth/session.ts',
                status: 'modified',
                source: 'reported',
                binary: false,
                diffable: true,
                additions: 6,
                deletions: 6,
                decision: 'pending',
                hunks: [],
                linesOmitted: true,
                restorable: true
              },
              {
                absPath: 'C:\\work\\project\\src\\auth\\guard.test.ts',
                path: 'src/auth/guard.test.ts',
                status: 'created',
                source: 'reported',
                binary: false,
                diffable: true,
                additions: 20,
                deletions: 0,
                decision: 'pending',
                hunks: [],
                linesOmitted: true,
                restorable: true
              }
            ]
          }
        }
      ];
    }
    case 'plan-todos': {
      const messages = baseMessages({
        title: 'Plan the auth refactor',
        threadId: THREAD_ID,
        replay: [
          userItem('Plan the auth refactor before touching files.'),
          assistantItem('Here is a plan with four steps. Build it when you want me to start.')
        ]
      });
      return [
        ...messages,
        {
          type: 'plan',
          plan: {
            path: '.melink/plans/auth-refactor.md',
            title: 'Plan the auth refactor',
            summary: 'Consolidate the guard and keep the audit trail.',
            body:
              '## Approach\n\nMove the duplicated session check into one helper. The audit event stays in the same order, and the deny path gets a regression test.',
            steps: [
              { text: 'Read the current middleware and session guard', status: 'completed' },
              { text: 'Extract `requireSession` and update both call sites', status: 'inProgress' },
              { text: 'Add a deny-path regression test', status: 'pending' },
              { text: 'Run typecheck, unit tests, and the build', status: 'pending' }
            ],
            built: false,
            updatedAt: FIXED_UPDATED_AT
          }
        }
      ];
    }
    case 'chat-queued': {
      const messages = baseMessages({
        title: 'Refactor the auth guard',
        threadId: THREAD_ID,
        replay: [
          userItem('Refactor the auth guard and keep the audit log intact.'),
          assistantItem(
            'I extracted the guard into `requireSession`. I am running the focused tests now.'
          )
        ]
      });
      return [
        ...messages,
        {
          type: 'busy',
          value: true,
          backendId: 'ollama',
          threadId: THREAD_ID
        },
        {
          type: 'composerDraft',
          tabId: `tab-${THREAD_ID}`,
          text: 'Also update the deny-path screenshot after this.',
          attachments: [
            {
              id: 'attach-visual-1',
              name: 'login-screen.png',
              mimeType: 'image/png',
              size: 2048,
              kind: 'image',
              dataUrl:
                'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
            }
          ]
        },
        {
          type: 'queuedTurns',
          entries: [
            {
              id: 'queued-1',
              textPreview: 'Run the focused guard test and paste the log.',
              attachmentCount: 0
            },
            {
              id: 'queued-2',
              textPreview: 'Then refresh the docs screenshot.',
              attachmentCount: 1,
              attachmentNames: ['audit-log.txt']
            }
          ]
        }
      ];
    }
    case 'settings':
    case 'settings-orchestration':
    case 'settings-provider-local': {
      const messages = baseMessages({ title: 'New chat' });
      return [...messages, { type: 'showSettings' }];
    }
    default:
      throw new Error(`No fixture for screen "${slug}"`);
  }
}
