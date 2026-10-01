import type { TodoStepStatus } from './backends/types';

/** Visible name for a step status. The icon carries the same state. */
export function stepStatusLabel(status: TodoStepStatus): string {
  switch (status) {
    case 'completed':
      return 'Done';
    case 'inProgress':
      return 'In progress';
    case 'denied':
      return 'Denied';
    default:
      return 'To do';
  }
}

/** Class suffix for a step status icon. */
export function stepStatusKind(status: TodoStepStatus): 'todo' | 'progress' | 'done' | 'denied' {
  switch (status) {
    case 'completed':
      return 'done';
    case 'inProgress':
      return 'progress';
    case 'denied':
      return 'denied';
    default:
      return 'todo';
  }
}

/**
 * Empty status element. The preview stylesheet draws the shape, because the
 * built-in markdown preview strips inline SVG. An empty ring is still to do,
 * a spinning ring is in progress, a check is done, and a cross is denied.
 */
export function stepStatusHtml(status: TodoStepStatus): string {
  const kind = stepStatusKind(status);
  const label = stepStatusLabel(status);
  return `<span class="melink-step melink-step--${kind}" role="img" aria-label="${label}"></span>`;
}
