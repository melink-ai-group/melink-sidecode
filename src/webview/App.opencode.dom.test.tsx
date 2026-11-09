import { expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { postMessage, sendHostMessage } from './domSetup';
import type { HostToWebviewMessage } from '../protocol';
// @ts-expect-error The shared JavaScript visual fixtures have no declaration file.
import { screenMessages } from '../../tools/visual-harness/fixtures.mjs';

it('installs bundled v2 from the unsaved draft and shows pending and failure states', async () => {
  render(<App />);
  act(() => {
    for (const message of screenMessages('settings') as HostToWebviewMessage[]) sendHostMessage(message);
  });
  fireEvent.click(screen.getByRole('tab', { name: 'CLI' }));
  const source = screen.getByLabelText('opencode CLI source') as HTMLSelectElement;
  fireEvent.change(source, { target: { value: 'bundled-v2' } });
  expect(source.value).toBe('bundled-v2');
  expect(screen.getByText('Bundled CLI not found. Install opencode to download it.')).toBeTruthy();
  source.focus();
  expect(document.activeElement).toBe(source);
  fireEvent.click(screen.getByRole('button', { name: 'Install bundled opencode' }));
  expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'installOpencode', cliSource: 'bundled-v2' }));
  act(() => sendHostMessage({ type: 'opencodeInstall', pending: true }));
  expect(screen.getByRole('button', { name: 'Installing...' }).hasAttribute('disabled')).toBe(true);
  expect(source.disabled).toBe(true);
  act(() => sendHostMessage({ type: 'opencodeInstall', pending: false, ok: false, message: 'Download failed. Try again.' }));
  await waitFor(() => expect(screen.getByText('Download failed. Try again.')).toBeTruthy());
  expect(source.disabled).toBe(false);
  fireEvent.change(source, { target: { value: 'local' } });
  expect(screen.queryByText('Download failed. Try again.')).toBeNull();
});

it('saves bundled v2 and uses its detected version and update action', () => {
  render(<App />);
  act(() => {
    for (const message of screenMessages('settings') as HostToWebviewMessage[]) {
      if (message.type === 'settings') message.settings.opencode.bundledV2 = { path: '/storage/opencode-v2/bin/opencode', status: 'detected', version: '2.2.6' };
      sendHostMessage(message);
    }
  });
  fireEvent.click(screen.getByRole('tab', { name: 'CLI' }));
  fireEvent.change(screen.getByLabelText('opencode CLI source'), { target: { value: 'bundled-v2' } });
  expect(screen.getByText('2.2.6')).toBeTruthy();
  expect(screen.getByText('/storage/opencode-v2/bin/opencode')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Update bundled opencode' }));
  expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'upgradeOpencode', cliSource: 'bundled-v2' }));
  fireEvent.click(screen.getByRole('button', { name: /Save settings/ }));
  expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'saveSettings', patch: expect.objectContaining({ opencodeCliSource: 'bundled-v2' }) }));
});
