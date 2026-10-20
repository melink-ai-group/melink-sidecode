import type {
  DiffReviewFinding,
  DiffReviewResult,
  DiffReviewSeverity
} from '../review/diffReview.ts';

/**
 * The display model for the advisory diff-review section.
 *
 * Pure labels keep the React surface free of status branching: the component
 * renders exactly what this helper returns, and the tests pin the reviewed,
 * no-findings, and failed wording without mounting a webview. Severity is always
 * a visible word plus a tone for the icon; colour is never the only signal.
 */

export type DiffReviewKind = 'findings' | 'empty' | 'failed';
export type DiffReviewTone = DiffReviewSeverity | 'ok';

export interface DiffReviewFindingView {
  severity: DiffReviewSeverity;
  severityLabel: string;
  location: string;
  message: string;
}

export interface DiffReviewView {
  kind: DiffReviewKind;
  tone: DiffReviewTone;
  /** Compact label shown in the collapsed review header. */
  summary: string;
  heading: string;
  detail?: string;
  findings: DiffReviewFindingView[];
}

/** The section to render, or `undefined` when this turn was never reviewed. */
export function diffReviewView(result: DiffReviewResult | undefined): DiffReviewView | undefined {
  if (!result) {
    return undefined;
  }
  if (result.status === 'failed') {
    return {
      kind: 'failed',
      tone: 'warning',
      summary: 'Review unavailable',
      heading: 'Diff review unavailable.',
      detail: result.notice ?? 'The diff review could not complete. Your changes are still ready for review.',
      findings: []
    };
  }
  if (result.findings.length === 0) {
    return {
      kind: 'empty',
      tone: 'ok',
      summary: 'Review: clean',
      heading: 'No diff-review findings.',
      findings: []
    };
  }
  const findings = result.findings.map(findingView);
  return {
    kind: 'findings',
    tone: highestSeverity(findings),
    summary: `Review: ${findings.length} finding${findings.length === 1 ? '' : 's'}`,
    heading: `${findings.length} diff-review finding${findings.length === 1 ? '' : 's'}`,
    findings
  };
}

/** One finding as the panel shows it: severity word, `path:line`, then message. */
export function findingView(finding: DiffReviewFinding): DiffReviewFindingView {
  return {
    severity: finding.severity,
    severityLabel: severityLabel(finding.severity),
    location: `${finding.path}:${finding.line}`,
    message: finding.message
  };
}

export function severityLabel(severity: DiffReviewSeverity): string {
  return severity === 'error' ? 'Error' : severity === 'warning' ? 'Warning' : 'Info';
}

function highestSeverity(findings: readonly DiffReviewFindingView[]): DiffReviewSeverity {
  if (findings.some((finding) => finding.severity === 'error')) {
    return 'error';
  }
  if (findings.some((finding) => finding.severity === 'warning')) {
    return 'warning';
  }
  return 'info';
}
