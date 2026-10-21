import type { PersistedPlanState } from '../backends/threadStore';
import type { CheckpointPlanState } from '../changes/journal';

export function rewindKey(backendId: string, threadId: string): string {
  return `${backendId}\0${threadId}`;
}

export function planSnapshot(state: PersistedPlanState): CheckpointPlanState {
  return {
    path: state.path,
    title: state.title,
    summary: state.summary,
    body: state.body,
    steps: state.steps.map((step) => ({ text: step.text, status: step.status })),
    built: state.built,
    completedDismissed: state.completedDismissed,
    updatedAt: state.updatedAt
  };
}
