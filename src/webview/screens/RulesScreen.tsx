import { useEffect, useRef, type JSX } from 'react';
import type { ApprovalRule } from '../../backends/types';
import { BackIcon, ShieldIcon } from '../Icons';

/**
 * The always-allow rules surface: the one-click destination of the revocation
 * route from an `always` decision. It names exactly what each rule allows and
 * removes it in one action, with an empty state that explains how rules appear.
 */
export function RulesScreen({
  rules,
  onBack,
  onRevoke
}: {
  rules: ApprovalRule[];
  onBack: () => void;
  onRevoke: (rule: ApprovalRule) => void;
}): JSX.Element {
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    backRef.current?.focus();
  }, []);

  return (
    <main className="app">
      <header className="view-title">
        <button className="icon-btn" type="button" aria-label="Back to chat" ref={backRef} onClick={onBack}>
          <BackIcon />
        </button>
        <span className="view-title__name">Always-allow rules</span>
      </header>

      {rules.length === 0 ? (
        <div className="empty-state" role="status">
          <span className="empty-icon" aria-hidden="true">
            <ShieldIcon />
          </span>
          <p className="empty-title">No always-allow rules</p>
          <p className="empty-text">
            When you choose “always allow” at an approval prompt, the rule appears here so you can remove it
            later.
          </p>
        </div>
      ) : (
        <div className="rules" aria-label="Always-allow rules">
          <p className="rules-intro">
            Rules you added from an “always allow” decision. Removing one brings the approval prompt back for
            that request.
          </p>
          <ul className="rules-list">
            {rules.map((rule) => (
              <li className="rule" key={rule.id}>
                <div className="rule-head">
                  <span className="rule-what" title={rule.scope}>
                    {rule.scope}
                  </span>
                  <span className="rule-scope">Lasting rule</span>
                </div>
                <div className="rule-foot">
                  <span className="rule-meta">{rule.kind}</span>
                  <span className="spacer" />
                  <button
                    className="btn btn--quiet"
                    type="button"
                    aria-label={`Remove rule allowing ${rule.scope}`}
                    onClick={() => onRevoke(rule)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}
