import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STYLING_NO_BRAND_KIT_NOTICE,
  buildStylingReviewPrompt,
  hasFrontendWork,
  isFrontendPath,
  localStylingReview,
  runStylingReview,
  shouldRunStylingCheck,
  type StylingReviewInput
} from './stylingReview.ts';

const BRAND_KIT = [
  {
    path: 'design-systems/melink/tokens.css',
    text: ':root { --melink-shell: #019ACE; --melink-radius-sm: 4px; }'
  }
];

function input(overrides: Partial<StylingReviewInput> = {}): StylingReviewInput {
  return {
    request: 'Add a settings card.',
    brandKit: BRAND_KIT,
    files: [
      {
        path: 'src/webview/Card.tsx',
        diff: [
          '@@ -0,0 +1,3 @@',
          '+export function Card() {',
          '+  return <div style={{ color: "#fff" }} className="card" />;',
          '+}'
        ].join('\n')
      }
    ],
    ...overrides
  };
}

test('only frontend paths count as frontend work', () => {
  assert.equal(isFrontendPath('src/webview/App.tsx'), true);
  assert.equal(isFrontendPath('src/webview/styles/04-transcript.css'), true);
  assert.equal(isFrontendPath('src/backends/registry.ts'), false);
  assert.equal(hasFrontendWork([{ path: 'src/backends/registry.ts' }]), false);
  assert.equal(
    hasFrontendWork([{ path: 'src/backends/registry.ts' }, { path: 'src/webview/App.tsx' }]),
    true
  );
});

test('the gate needs the toggle on and a frontend change', () => {
  assert.equal(shouldRunStylingCheck(true, [{ path: 'src/webview/App.tsx' }]), true);
  assert.equal(shouldRunStylingCheck(false, [{ path: 'src/webview/App.tsx' }]), false);
  assert.equal(shouldRunStylingCheck(true, [{ path: 'src/backends/registry.ts' }]), false);
});

test('the local pass flags literal colours and inline styles in new component lines', () => {
  const result = localStylingReview(input());
  assert.equal(result.status, 'reviewed');
  assert.equal(result.findings[0]?.path, 'src/webview/Card.tsx');
  assert.equal(result.findings[0]?.line, 2);
  assert.match(result.findings[0]?.message ?? '', /Hardcoded hex color/);
  assert.ok(result.findings.some((finding) => /Inline style/.test(finding.message)));
  assert.equal(result.notice, undefined);
});

test('a literal colour is expected in a token file', () => {
  const result = localStylingReview(
    input({
      files: [
        {
          path: 'tokens.css',
          diff: '@@ -0,0 +1,1 @@\n+:root { --melink-shell: #019ACE; }'
        }
      ]
    })
  );
  assert.equal(result.status, 'no-findings');
  assert.deepEqual(result.findings, []);
});

test('an unknown brand token is reported only when a brand kit exists', () => {
  const result = localStylingReview(
    input({
      files: [
        {
          path: 'src/webview/card.css',
          diff: '@@ -0,0 +1,2 @@\n+.card { color: var(--melink-shell); }\n+.card__x { color: var(--melink-missing); }'
        }
      ]
    })
  );
  assert.ok(result.findings.some((finding) => /--melink-missing/.test(finding.message)));
  assert.equal(result.findings.some((finding) => /--melink-shell/.test(finding.message)), false);

  const noKit = localStylingReview(
    input({
      brandKit: [],
      files: [
        {
          path: 'src/webview/card.css',
          diff: '@@ -0,0 +1,1 @@\n+.card { color: var(--melink-missing); }'
        }
      ]
    })
  );
  assert.equal(noKit.findings.some((finding) => /--melink-missing/.test(finding.message)), false);
  assert.equal(noKit.notice, STYLING_NO_BRAND_KIT_NOTICE);
});

test('a hardcoded font and !important are advisory findings', () => {
  const result = localStylingReview(
    input({
      files: [
        {
          path: 'src/webview/card.css',
          diff: '@@ -0,0 +1,2 @@\n+.card { font-family: Inter; }\n+.card { color: red !important; }'
        }
      ]
    })
  );
  assert.ok(result.findings.some((finding) => /font family/.test(finding.message)));
  assert.ok(result.findings.some((finding) => /!important/.test(finding.message)));
});

test('the prompt carries the brand kit and the changed frontend files', () => {
  const prompt = buildStylingReviewPrompt(input());
  assert.match(prompt, /melink-shell/);
  assert.match(prompt, /src\/webview\/Card\.tsx/);
  assert.match(prompt, /read-only styling-consistency reviewer/i);
});

test('a throwing runner becomes a visible, non-blocking failure', async () => {
  const result = await runStylingReview(input(), async () => {
    throw new Error('no reviewer');
  });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.findings, []);
  assert.match(result.notice ?? '', /still ready for review/);
});
