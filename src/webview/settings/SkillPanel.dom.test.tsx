import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SkillPanel, type SkillPanelProps } from './SkillPanel';
import { skillStatusText } from './skillState';

function props(overrides: Partial<SkillPanelProps> = {}): SkillPanelProps {
  return {
    id: 'ast-grep',
    title: 'ast-grep',
    about: 'Structural search.',
    oneLineHelp: 'Structural search and rewrite by AST pattern.',
    checked: true,
    toggleLabel: 'Use structural search',
    toggleTip: 'Updates your user OpenCode config.',
    togglePending: false,
    onToggle: vi.fn(),
    chip: { label: 'Ready', tone: 'ready' },
    statusText: 'Ready. A new OpenCode session uses it.',
    cliSource: 'local',
    onCliSource: vi.fn(),
    sourceHelp: 'Use the path below or PATH.',
    pathLabel: 'ast-grep path',
    pathValue: 'ast-grep',
    onPath: vi.fn(),
    probeStatus: 'detected',
    probeVersion: '0.51.0',
    installLabel: 'Update ast-grep',
    installPending: false,
    onInstall: vi.fn(),
    testPending: false,
    onTest: vi.fn(),
    ...overrides
  };
}

describe('SkillPanel', () => {
  it('puts the enable toggle before the CLI controls and reflects the saved flag', () => {
    render(<SkillPanel {...props()} />);
    const checkbox = screen.getByRole('checkbox', { name: 'Use structural search' }) as HTMLInputElement;
    const source = screen.getByLabelText('CLI source');
    expect(checkbox.checked).toBe(true);
    expect(checkbox.compareDocumentPosition(source) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('names a missing binary and keeps the toggle available', () => {
    render(
      <SkillPanel
        {...props()}
        checked={false}
        chip={{ label: 'Missing binary', tone: 'missing' }}
        probeStatus="missing"
        installLabel="Install ast-grep"
      />
    );
    expect(screen.getByText('Missing binary')).toBeTruthy();
    expect(screen.getByText(/not installed/i)).toBeTruthy();
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(false);
  });

  it('shows the index-missing chip, guidance and Build index action', () => {
    render(
      <SkillPanel
        {...props({
          id: 'zvec-grep',
          title: 'zvec-grep',
          toggleLabel: 'Use semantic search',
          chip: { label: 'Index missing', tone: 'index' },
          statusText: skillStatusText({
            skill: 'zvecGrep',
            pending: false,
            snapshot: {
              enabled: true,
              connected: true,
              cli: 'installed',
              status: 'detected',
              index: 'missing'
            }
          }),
          indexState: 'missing',
          onBuildIndex: vi.fn(),
          installLabel: 'Update zvec-grep'
        })}
      />
    );
    expect(screen.getByText('Index missing')).toBeTruthy();
    expect(screen.getByText(/Needs a workspace index/)).toBeTruthy();
    expect(screen.queryByText(/^Ready\./)).toBeNull();
    expect(screen.getByText(/INDEX_MISSING/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Build index' })).toBeTruthy();
  });

  it('disables the toggle and every action while pending and marks aria-busy', () => {
    render(
      <SkillPanel
        {...props({
          togglePending: true,
          installPending: true,
          testPending: true,
          indexPending: true,
          indexState: 'missing',
          onBuildIndex: vi.fn()
        })}
      />
    );
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect(document.querySelector('.skill-enable')?.getAttribute('aria-busy')).toBe('true');
    for (const button of screen.getAllByRole('button')) {
      if (button.textContent && /Working|Testing|Building/.test(button.textContent)) {
        expect((button as HTMLButtonElement).disabled).toBe(true);
        expect(button.getAttribute('aria-busy')).toBe('true');
      }
    }
  });

  it('renders an error detail and a failed Test result as alerts', () => {
    render(
      <SkillPanel
        {...props({
          chip: { label: 'Error', tone: 'error' },
          statusText: 'On, but OpenCode is not connected yet.',
          detail: 'The ast-grep MCP shim did not answer.',
          testResult: { ok: false, message: 'The ast-grep MCP shim did not answer.' }
        })}
      />
    );
    const alerts = screen.getAllByRole('alert').map((node) => node.textContent ?? '');
    expect(alerts.some((text) => /MCP shim did not answer/.test(text))).toBe(true);
  });

  it('forwards the toggle and action clicks', () => {
    const onToggle = vi.fn();
    const onTest = vi.fn();
    render(<SkillPanel {...props({ onToggle, onTest })} />);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(onToggle).toHaveBeenCalledWith(false);
    expect(onTest).toHaveBeenCalled();
  });
});
