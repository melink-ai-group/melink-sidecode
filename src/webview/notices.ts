import type { Dispatch } from 'react';
import type { Action, AppState } from './state';

export function runTokenAction(dispatch: Dispatch<Action>, state: AppState): void {
  const needsToken = state.availability.find((backend) => backend.status === 'unauthenticated');
  dispatch({
    type: 'notice',
    level: 'warning',
    message: needsToken?.detail ?? 'Enter a token to continue.',
    action: 'setToken'
  });
}

export function noticeActionLabel(action: 'setToken' | 'clearToken' | 'refresh' | 'retry'): string {
  switch (action) {
    case 'setToken':
      return 'Set token';
    case 'clearToken':
      return 'Clear token';
    case 'refresh':
      return 'Refresh backends';
    case 'retry':
      return 'Retry';
  }
}

