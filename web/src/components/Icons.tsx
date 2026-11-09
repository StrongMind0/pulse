import type { Severity } from "@/lib/types";

/** Status always ships as icon + label, never colour alone. */
export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span className={`sev sev--${severity.toLowerCase()}`}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        {severity === "CRITICAL" ? (
          <path d="M6 1 L11 10 H1 Z" />
        ) : severity === "WARNING" ? (
          <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" transform="rotate(45 6 6)" />
        ) : (
          <circle cx="6" cy="6" r="4.5" />
        )}
      </svg>
      {severity === "CRITICAL" ? "Critical" : severity === "WARNING" ? "Warning" : "Info"}
    </span>
  );
}

export function OnlineDot({ online }: { online: boolean }) {
  return (
    <span className={online ? "dot dot--on" : "dot dot--off"}>
      <span aria-hidden="true" />
      {online ? "Online" : "Offline"}
    </span>
  );
}

export function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" className="logo">
      <path d="M2 12h4l3-7 4 14 3-7h6" fill="none" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
