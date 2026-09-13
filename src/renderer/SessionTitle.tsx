import { SessionRow } from './SessionRow';
import type { SessionSummary } from '../shared/types';
export function SessionTitle({ sessionId, title, titleSource, titleRevision, disabled = false }: Pick<SessionSummary, 'title' | 'titleSource' | 'titleRevision'> & { sessionId: string; disabled?: boolean }) {
  return <SessionRow key={sessionId} titleOnly selected={false} onSelect={() => {}} row={{ id: sessionId, title, titleSource, titleRevision, startedAt: '', durationSec: 0, status: disabled ? 'recording' : 'complete', jobs: { live: 'idle', refined: 'idle', speakers: 'idle' } }} />;
}
