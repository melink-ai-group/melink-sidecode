import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Markdown } from './Markdown';
import './planPreview.css';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

interface PlanMessage {
  type: 'plan';
  markdown?: string;
  canBuild?: boolean;
  title?: string;
}

/**
 * Rendered plan document. The host posts the markdown; Build is the only
 * action, and it asks the host to leave Plan mode and execute the steps.
 */
function PlanPreviewApp() {
  const [markdown, setMarkdown] = useState('');
  const [canBuild, setCanBuild] = useState(false);
  const [building, setBuilding] = useState(false);

  useEffect(() => {
    const onMessage = (event: MessageEvent<PlanMessage>): void => {
      const data = event.data;
      if (!data || data.type !== 'plan') {
        return;
      }
      setMarkdown(data.markdown ?? '');
      const nextCanBuild = data.canBuild === true;
      setCanBuild(nextCanBuild);
      if (!nextCanBuild) {
        setBuilding(false);
      }
    };
    window.addEventListener('message', onMessage);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const build = (): void => {
    if (!canBuild || building) {
      return;
    }
    setBuilding(true);
    vscode.postMessage({ type: 'build' });
  };

  return (
    <div className="plan-preview">
      <header className="plan-preview__bar">
        <span className="plan-preview__spacer" />
        <button
          className="plan-preview__build"
          type="button"
          disabled={!canBuild || building}
          title="Build this plan in Agent mode"
          onClick={build}
        >
          {building ? 'Building…' : 'Build'}
        </button>
      </header>
      <article className="plan-preview__doc" tabIndex={0} aria-label="Plan document">
        {markdown ? <Markdown text={markdown} /> : <p className="plan-preview__empty">This plan has no content yet.</p>}
      </article>
    </div>
  );
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<PlanPreviewApp />);
}
