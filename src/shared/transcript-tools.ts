export type TurnCorrectionMeta = {
  revision: string;
  originalText: string;
  originalSpeaker: string;
  edited: boolean;
  speakerOverridden: boolean;
  canUndo: boolean;
};
export type CorrectTurnInput = { sessionId: string; turnId: string; revision: string; text: string; speaker: string };
export type TurnCorrectionInput = { sessionId: string; turnId: string; revision: string };
export type TranscriptSearchInput = { query: string; limit?: number };
export type TranscriptSearchHit = { sessionId: string; sessionTitle: string; turnId: string | null; tStartMs: number | null; snippet: string; revision?: string; speaker?: string };
export type TranscriptSearchResult = { ok: true; hits: TranscriptSearchHit[]; truncated: boolean } | { ok: false; error: string };
export type Bookmark = { id: string; tStartMs: number; label: string };
export type AddBookmarkInput = { sessionId: string; tStartMs: number; label?: string };
export type DeleteBookmarkInput = { sessionId: string; bookmarkId: string };
