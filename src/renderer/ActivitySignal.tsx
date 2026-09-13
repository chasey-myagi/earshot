/** Compact status ring inspired by Libraries.dev's state-led loading indicators.
 * CSS only: it runs only while work is pending and respects reduced motion. */
export function ActivitySignal() {
  return <span className="activity-signal" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /></svg></span>;
}
