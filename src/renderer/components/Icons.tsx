interface IconProps {
  className?: string;
}

const strokeProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export function MicIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" {...strokeProps}>
      <rect x="6" y="2" width="4" height="7" rx="2" />
      <path d="M4 7.5a4 4 0 0 0 8 0" />
      <path d="M8 11.5V14" />
    </svg>
  );
}

export function StopIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" {...strokeProps}>
      <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function GearIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M6.78 3.46L6.78 1.11A7 7 0 0 1 9.22 1.11L9.22 3.46A4.7 4.7 0 0 1 10.35 3.93L12.02 2.27A7 7 0 0 1 13.73 3.98L12.07 5.65A4.7 4.7 0 0 1 12.54 6.78L14.89 6.78A7 7 0 0 1 14.89 9.22L12.54 9.22A4.7 4.7 0 0 1 12.07 10.35L13.73 12.02A7 7 0 0 1 12.02 13.73L10.35 12.07A4.7 4.7 0 0 1 9.22 12.54L9.22 14.89A7 7 0 0 1 6.78 14.89L6.78 12.54A4.7 4.7 0 0 1 5.65 12.07L3.98 13.73A7 7 0 0 1 2.27 12.02L3.93 10.35A4.7 4.7 0 0 1 3.46 9.22L1.11 9.22A7 7 0 0 1 1.11 6.78L3.46 6.78A4.7 4.7 0 0 1 3.93 5.65L2.27 3.98A7 7 0 0 1 3.98 2.27L5.65 3.93A4.7 4.7 0 0 1 6.78 3.46ZM8 6A2 2 0 1 0 8 10A2 2 0 1 0 8 6Z"
      />
    </svg>
  );
}

export function ClearIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" {...strokeProps}>
      <path d="M3.5 4.5h9" />
      <path d="M6 2.5h4l.5 2h-5z" />
      <path d="M5 6.5l.5 7h5l.5-7" />
      <path d="M7 7.5v4M9 7.5v4" />
    </svg>
  );
}

export function CloseIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" {...strokeProps}>
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
    </svg>
  );
}

export function ExternalLinkIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" {...strokeProps}>
      <path d="M7 3.5H3.5v9h9V9" />
      <path d="M10 2.5h3.5V6M13.5 2.5L7.75 8.25" />
    </svg>
  );
}

export function SparkleIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
      <path
        d="M12 2.5l1.95 5.55L19.5 10l-5.55 1.95L12 17.5l-1.95-5.55L4.5 10l5.55-1.95z"
        fill="currentColor"
      />
      <path
        d="M18.25 14.5l.85 2.4 2.4.85-2.4.85-.85 2.4-.85-2.4-2.4-.85 2.4-.85z"
        fill="currentColor"
        opacity="0.55"
      />
    </svg>
  );
}

export function WarningIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" width="30" height="30" aria-hidden="true" {...strokeProps}>
      <path d="M12 3.75L21 19.5H3z" />
      <path d="M12 10v4.25" />
      <circle cx="12" cy="16.9" r="0.85" fill="currentColor" stroke="none" />
    </svg>
  );
}
