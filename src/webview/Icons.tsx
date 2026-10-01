import type { JSX, SVGProps } from 'react';

/**
 * Inline icon set. Stroke widths mirror the prototype so the sidebar reads at
 * the same weight as workbench chrome; every icon inherits `currentColor`.
 */

type IconProps = SVGProps<SVGSVGElement> & { className?: string };

function base(className: string, strokeWidth: number, props: IconProps, children: JSX.Element): JSX.Element {
  const { className: extra, ...rest } = props;
  return (
    <svg
      className={extra ? `${className} ${extra}` : className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const ChevronDownIcon = (props: IconProps): JSX.Element =>
  base('ico ico--xs', 2, props, <path d="m6 9 6 6 6-6" />);

export const RefreshIcon = (props: IconProps): JSX.Element =>
  base('ico ico--sm', 1.6, props, (
    <>
      <path d="M20 11a8 8 0 1 0-1.6 5" />
      <path d="M20 5v6h-6" />
    </>
  ));

export const NewChatIcon = (props: IconProps): JSX.Element =>
  base('ico ico--sm', 1.6, props, (
    <>
      <path d="M20 12a8 8 0 1 1-3.2-6.4" />
      <path d="M20 4v5h-5" />
    </>
  ));

export const HistoryIcon = (props: IconProps): JSX.Element =>
  base('ico ico--sm', 1.6, props, (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 5v5h5" />
      <path d="M12 8v4l3 2" />
    </>
  ));

export const SettingsIcon = (props: IconProps): JSX.Element =>
  base('ico ico--sm', 1.6, props, (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M17.7 6.3l-1.4 1.4M7.7 16.3l-1.4 1.4" />
    </>
  ));

export const TerminalIcon = (props: IconProps): JSX.Element =>
  base('ico ico--sm', 1.6, props, (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </>
  ));

export const FileIcon = (props: IconProps): JSX.Element =>
  base('ico ico--sm', 1.6, props, (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
    </>
  ));

export const ContextIcon = (props: IconProps): JSX.Element =>
  base('ico ico--sm', 1.6, props, (
    <>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z" />
      <path d="M4 8h16M8 8v12M11 12h6M11 15.5h4" />
    </>
  ));

export const CheckIcon = (props: IconProps): JSX.Element =>
  base('ico ico--xs', 2.2, props, <path d="m5 13 4 4 10-10" />);

export const CrossIcon = (props: IconProps): JSX.Element =>
  base('ico ico--xs', 2.2, props, <path d="M6 6l12 12M18 6 6 18" />);

export const CopyIcon = (props: IconProps): JSX.Element =>
  base('ico ico--xs', 1.6, props, (
    <>
      <rect x="9" y="9" width="11" height="11" rx="1.5" />
      <path d="M5 15V5a1 1 0 0 1 1-1h9" />
    </>
  ));

export const PaperclipIcon = (props: IconProps): JSX.Element =>
  base('ico ico--sm', 1.6, props, (
    <path d="M8 12.5 14.5 6a3 3 0 0 1 4.2 4.2L11 18a5 5 0 0 1-7-7l7.5-7.5" />
  ));

export const ArrowIcon = (props: IconProps): JSX.Element =>
  base('ico ico--xs', 2, props, <path d="M5 12h13M13 6l6 6-6 6" />);

export const StopIcon = (props: IconProps): JSX.Element =>
  base('ico ico--xs', 2, props, <rect x="6" y="6" width="12" height="12" rx="2" />);

export const AlertIcon = (props: IconProps): JSX.Element =>
  base('ico', 1.6, props, (
    <>
      <path d="M12 3 2 20h20L12 3z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ));

export const SparkIcon = (props: IconProps): JSX.Element =>
  base('ico', 1.5, props, (
    <>
      <path d="M12 3l1.9 4.6L18.5 9l-4.6 1.4L12 15l-1.9-4.6L5.5 9l4.6-1.4L12 3z" />
      <path d="M18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9L18 15z" />
    </>
  ));

export const SearchIcon = (props: IconProps): JSX.Element =>
  base('ico ico--xs', 1.8, props, (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" />
    </>
  ));

export const InfoIcon = (props: IconProps): JSX.Element =>
  base('ico ico--xs', 1.6, props, (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ));

export const BackIcon = (props: IconProps): JSX.Element =>
  base('ico ico--sm', 1.8, props, <path d="M15 6l-6 6 6 6" />);

export const ShieldIcon = (props: IconProps): JSX.Element =>
  base('ico ico--xs', 1.6, props, (
    <>
      <path d="M12 3 5 6v5c0 4 3 7.4 7 9 4-1.6 7-5 7-9V6l-7-3z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ));

export const SlidersIcon = (props: IconProps): JSX.Element =>
  base('ico ico--sm', 1.6, props, (
    <>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </>
  ));

export const PlanIcon = (props: IconProps): JSX.Element =>
  base('ico ico--sm', 1.6, props, (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="M4 6h.01M4 12h.01M4 18h.01" />
    </>
  ));

export const AskIcon = (props: IconProps): JSX.Element =>
  base('ico ico--sm', 1.6, props, (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ));

export const ChevronRightIcon = (props: IconProps): JSX.Element =>
  base('ico ico--xs', 2, props, <path d="m9 6 6 6-6 6" />);

export const RestoreIcon = (props: IconProps): JSX.Element =>
  base('ico ico--sm', 1.6, props, (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </>
  ));

export const DiffIcon = (props: IconProps): JSX.Element =>
  base('ico ico--sm', 1.6, props, (
    <>
      <path d="M12 4v16" />
      <path d="M8 8H5M8 12H5M8 16H5" />
      <path d="M16 8h3M16 12h3M16 16h3" />
    </>
  ));

export const PlusIcon = (props: IconProps): JSX.Element =>
  base('ico ico--xs', 2, props, <path d="M12 5v14M5 12h14" />);

export const PencilIcon = (props: IconProps): JSX.Element =>
  base('ico ico--xs', 2, props, (
    <>
      <path d="M4 20h4L20 8l-4-4L4 16z" />
      <path d="M14 6l4 4" />
    </>
  ));

export const TrashIcon = (props: IconProps): JSX.Element =>
  base('ico ico--xs', 2, props, (
    <>
      <path d="M5 7h14M9 7V5h6v2M7 7l1 12h8l1-12" />
    </>
  ));

export const RenameIcon = (props: IconProps): JSX.Element =>
  base('ico ico--xs', 2, props, (
    <>
      <path d="M4 12h13M13 7l5 5-5 5" />
      <path d="M20 5v14" />
    </>
  ));

export const PauseIcon = (props: IconProps): JSX.Element =>
  base('ico ico--xs', 1.8, props, (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ));
