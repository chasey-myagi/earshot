import { SessionRow } from './SessionRow';
export function SessionTitle({ sessionId, title, disabled = false }: { sessionId: string; title: string; disabled?: boolean }) {
  return <SessionRow titleOnly selected={false} onSelect={() => {}} row={{ id: sessionId, title, startedAt: '', durationSec: 0, status: disabled ? 'recording' : 'complete', jobs: { live: 'idle', refined: 'idle', speakers: 'idle' } }} />;
}
