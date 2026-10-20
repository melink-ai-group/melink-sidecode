/**
 * Frontend stack detection for the per-mode checklists.
 *
 * This module is host-free: it reads only the bounded project snapshot that
 * `projectContext.ts` already built, so it never touches the filesystem and
 * never adds a second manifest reader. The manifest's known frontend
 * dependencies are the primary signal; a framework config file in the bounded
 * file list corroborates it (a Next.js app, for example, lists `react` too, so
 * `next.config.*` is what disambiguates it from a plain React app).
 *
 * Detection is deliberately conservative: an unknown package, `react-dom`
 * without `react`, or a bare `vite.config.*` is not enough to name a framework,
 * because Vite is shared by several stacks. `none` means "not a frontend
 * project this module understands", not "no files".
 */

import type { ProjectSnapshot } from './projectContext.ts';

export type FrontendStack = 'next' | 'nuxt' | 'vue' | 'svelte' | 'react' | 'angular' | 'none';

/** Case-insensitive basename with POSIX separators, matching the snapshot's paths. */
function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return (index === -1 ? normalized : normalized.slice(index + 1)).toLowerCase();
}

/** True when a config file named `<stem>.<extension>` appears in the snapshot. */
function hasConfig(paths: readonly string[], stem: string): boolean {
  return paths.some((path) => {
    const name = basename(path);
    return name === stem || name.startsWith(`${stem}.`);
  });
}

/** Every known frontend dependency carried by any manifest in the snapshot. */
function declaredFrameworks(snapshot: ProjectSnapshot): Set<string> {
  const frameworks = new Set<string>();
  for (const manifest of snapshot.shape.manifests) {
    const raw = manifest.fields?.frameworks;
    if (!raw) {
      continue;
    }
    for (const name of raw.split(',')) {
      const trimmed = name.trim().toLowerCase();
      if (trimmed.length > 0) {
        frameworks.add(trimmed);
      }
    }
  }
  return frameworks;
}

/**
 * The project's frontend stack, or `none`.
 *
 * Priority is fixed so a full-stack project names the outermost framework:
 * Next > Nuxt > Vue > Svelte > Angular > React.
 */
export function detectFrontendStack(snapshot: ProjectSnapshot): FrontendStack {
  const frameworks = declaredFrameworks(snapshot);
  // Both lists are already bounded: `files` by the file cap and `tree` by the
  // tree cap. A path that was truncated away therefore only weakens
  // corroboration; the manifest dependency still decides on its own.
  const paths = [...snapshot.shape.files, ...snapshot.shape.tree.map((node) => node.path)];

  if (frameworks.has('next') || hasConfig(paths, 'next.config')) {
    return 'next';
  }
  if (frameworks.has('nuxt') || hasConfig(paths, 'nuxt.config')) {
    return 'nuxt';
  }
  if (frameworks.has('vue') || hasConfig(paths, 'vue.config')) {
    return 'vue';
  }
  if (frameworks.has('svelte') || frameworks.has('@sveltejs/kit') || hasConfig(paths, 'svelte.config')) {
    return 'svelte';
  }
  if (frameworks.has('@angular/core') || hasConfig(paths, 'angular.json')) {
    return 'angular';
  }
  if (frameworks.has('react')) {
    return 'react';
  }
  return 'none';
}

/**
 * The shared checklist every frontend change gets, whatever the framework.
 * Kept short enough to append to a mode prompt without crowding it.
 */
const BASE_CHECKLIST =
  'Frontend checklist: check loading, empty, and error states for every async view; validate input and show field-level errors; verify accessible labels, focus order, and keyboard reachability; check responsive layout and horizontal overflow at narrow widths; keep the console free of errors, uncaught exceptions, and failed network requests; keep copy and terminology consistent across the UI.';

/** One or two stack-specific lines, in the framework's own vocabulary. */
const STACK_CHECKLIST: Record<Exclude<FrontendStack, 'none'>, string> = {
  next: 'Next.js: confirm the server/client boundary, hydration without mismatches, and loading, error, and not-found route states.',
  nuxt: 'Nuxt: confirm server/client rendering, hydration without mismatches, and loading and error page states.',
  vue: 'Vue: confirm reactive updates render, v-for uses stable keys, and conditional content does not flash stale state.',
  svelte:
    'Svelte: confirm reactive statements update, each blocks use stable keys, and conditional content does not flash stale state.',
  angular:
    'Angular: confirm change detection updates the view, *ngFor uses trackBy, and conditional content does not flash stale state.',
  react:
    'React: confirm state and effects update correctly, lists use stable keys, and conditional content does not flash stale state.'
};

/** The compact checklist for a stack, or `undefined` when it is not a frontend. */
export function frontendChecklist(stack: FrontendStack): string | undefined {
  if (stack === 'none') {
    return undefined;
  }
  return `${BASE_CHECKLIST} ${STACK_CHECKLIST[stack]}`;
}
