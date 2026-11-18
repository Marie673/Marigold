import type { AiEvent, UiCommand, UiState } from '../shared/types.ts';

interface Bridge {
  invoke<T = unknown>(name: string, payload?: unknown): Promise<T>;
  on(event: 'state', cb: (s: UiState) => void): () => void;
  on(event: 'command', cb: (c: UiCommand) => void): () => void;
  on(event: 'ai', cb: (e: AiEvent) => void): () => void;
  on(event: 'found', cb: (r: { matches: number; active: number }) => void): () => void;
}

export const api = (window as unknown as { marigold: Bridge }).marigold;
