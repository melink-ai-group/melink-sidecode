import test from 'node:test';
import assert from 'node:assert/strict';
import { detectFrontendStack, frontendChecklist, type FrontendStack } from './frontendStack.ts';
import type { ProjectSnapshot } from './projectContext.ts';

interface Fixture {
  frameworks?: string;
  files?: string[];
  tree?: string[];
}

function snapshot(fixture: Fixture = {}): ProjectSnapshot {
  return {
    timestamp: 1_000,
    workspace: {
      names: ['app'],
      roots: ['/work/app'],
      multiRoot: false,
      isGitRepo: false,
      branch: null,
      remote: null,
      truncated: null
    },
    shape: {
      languages: [],
      tree: (fixture.tree ?? []).map((path) => ({ path, name: path, depth: 1, entries: 0 })),
      manifests:
        fixture.frameworks === undefined
          ? []
          : [{ path: 'package.json', kind: 'package.json', fields: { frameworks: fixture.frameworks } }],
      files: fixture.files ?? [],
      totalFiles: 0,
      languagesTruncated: false,
      truncated: null
    },
    instructions: { documents: [], noneFound: true, truncated: null },
    editor: { active: null, openEditors: [], dirtyFiles: [], terminalCwd: null, truncated: null },
    exclusions: { directories: [], patterns: [], user: [] },
    excludedPaths: [],
    truncated: null
  };
}

test('each known frontend dependency detects its stack', () => {
  assert.equal(detectFrontendStack(snapshot({ frameworks: 'next, react, react-dom' })), 'next');
  assert.equal(detectFrontendStack(snapshot({ frameworks: 'nuxt, vue' })), 'nuxt');
  assert.equal(detectFrontendStack(snapshot({ frameworks: 'vue' })), 'vue');
  assert.equal(detectFrontendStack(snapshot({ frameworks: 'svelte' })), 'svelte');
  assert.equal(detectFrontendStack(snapshot({ frameworks: '@sveltejs/kit, svelte' })), 'svelte');
  assert.equal(detectFrontendStack(snapshot({ frameworks: '@angular/core' })), 'angular');
  assert.equal(detectFrontendStack(snapshot({ frameworks: 'react, react-dom' })), 'react');
});

test('a project with no frontend evidence, or only ambiguous packages, is none', () => {
  assert.equal(detectFrontendStack(snapshot()), 'none');
  assert.equal(detectFrontendStack(snapshot({ frameworks: '' })), 'none');
  // A package manager could have installed react-dom on its own; it does not
  // name a framework.
  assert.equal(detectFrontendStack(snapshot({ frameworks: 'react-dom' })), 'none');
  assert.equal(detectFrontendStack(snapshot({ frameworks: 'solid-js' })), 'none');
  assert.equal(detectFrontendStack(snapshot({ frameworks: 'preact' })), 'none');
  assert.equal(detectFrontendStack(snapshot({ frameworks: 'unknown-ui' })), 'none');
});

test('framework config files corroborate a manifest that lists the inner library', () => {
  // A Next app also depends on react; the config is what proves it is Next.
  assert.equal(
    detectFrontendStack(snapshot({ frameworks: 'react, react-dom', files: ['next.config.mjs'] })),
    'next'
  );
  assert.equal(
    detectFrontendStack(snapshot({ frameworks: 'react, react-dom', files: ['src/app/page.tsx'], tree: ['nuxt.config.ts'] })),
    'nuxt'
  );
  assert.equal(detectFrontendStack(snapshot({ frameworks: 'react', files: ['vue.config.js'] })), 'vue');
  assert.equal(detectFrontendStack(snapshot({ frameworks: 'react', files: ['angular.json'] })), 'angular');
  assert.equal(detectFrontendStack(snapshot({ files: ['svelte.config.js'] })), 'svelte');
});

test('a bare vite config is ambiguous and does not name a stack', () => {
  assert.equal(detectFrontendStack(snapshot({ files: ['vite.config.ts'] })), 'none');
  assert.equal(detectFrontendStack(snapshot({ frameworks: 'react-dom', files: ['vite.config.ts'] })), 'none');
});

test('a truncated or malformed manifest field cannot throw or invent a stack', () => {
  assert.equal(detectFrontendStack(snapshot({ frameworks: 'react, @sveltejs/ki' })), 'react');
  assert.equal(detectFrontendStack(snapshot({ frameworks: ', , next, ' })), 'next');
  assert.equal(detectFrontendStack(snapshot({ frameworks: 'rea' })), 'none');
  assert.equal(detectFrontendStack(snapshot({ frameworks: 'react', tree: Array.from({ length: 400 }, (_, i) => `src/f${i}.ts`) })), 'react');
});

const REQUIRED_AREAS: readonly RegExp[] = [
  /loading/i,
  /empty/i,
  /error/i,
  /validat/i,
  /label/i,
  /focus/i,
  /keyboard/i,
  /responsive/i,
  /overflow/i,
  /console/i,
  /network/i,
  /copy/i
];

test('every detected stack gets the six required checklist areas', () => {
  const stacks: Exclude<FrontendStack, 'none'>[] = ['next', 'nuxt', 'vue', 'svelte', 'angular', 'react'];
  for (const stack of stacks) {
    const text = frontendChecklist(stack);
    assert.ok(text, `${stack} should have a checklist`);
    for (const area of REQUIRED_AREAS) {
      assert.match(text!, area, `${stack} is missing ${area}`);
    }
  }
});

test('each stack adds its own framework wording', () => {
  assert.match(frontendChecklist('next')!, /hydration/i);
  assert.match(frontendChecklist('next')!, /not-found/i);
  assert.match(frontendChecklist('nuxt')!, /hydration/i);
  assert.match(frontendChecklist('vue')!, /v-for/i);
  assert.match(frontendChecklist('vue')!, /reactive/i);
  assert.match(frontendChecklist('svelte')!, /each blocks/i);
  assert.match(frontendChecklist('angular')!, /change detection/i);
  assert.match(frontendChecklist('angular')!, /trackBy/);
  assert.match(frontendChecklist('react')!, /effects/i);
  assert.match(frontendChecklist('react')!, /stable keys/i);
});

test('a non-frontend project gets no checklist and every checklist stays compact', () => {
  assert.equal(frontendChecklist('none'), undefined);
  for (const stack of ['next', 'nuxt', 'vue', 'svelte', 'angular', 'react'] as const) {
    const text = frontendChecklist(stack)!;
    assert.ok(text.length <= 700, `${stack} checklist is ${text.length} chars`);
    assert.doesNotMatch(text, /Ask mode/i);
    assert.doesNotMatch(text, /Definition of Done/i);
  }
});
