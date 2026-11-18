import type { ChatMessage, ProfileData, SettingsData, TabData } from '../../sync/core/protocol.ts';

export type { ChatMessage, ProfileData, SettingsData, TabData };

export interface Profile extends ProfileData {
  id: string;
}

export interface TabView extends TabData {
  id: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  audible: boolean;
  /** No live web contents: the page reloads when the tab is opened. */
  asleep: boolean;
  /** Unread count etc. parsed from the page title by an integration. */
  badge: string | null;
}

export interface ArchivedTab extends TabData {
  id: string;
}

export interface LocalSettings {
  /** Background tabs idle for this long are unloaded from memory. 0 = never. */
  sleepAfterMs: number;
  aiProvider: string;
  aiModels: Record<string, string>;
  aiPanelOpen: boolean;
  deviceName: string;
  cliPaths: Record<string, string>;
}

export interface ProviderStatus {
  id: string;
  label: string;
  subscription: string;
  available: boolean;
  path: string | null;
  version: string | null;
  installHint: string;
}

export interface SyncStatus {
  state: 'off' | 'connecting' | 'ok' | 'error';
  server: string | null;
  error: string | null;
  lastSyncAt: number | null;
  devices: { id: string; name: string; platform: string; lastSeenAt: number; self: boolean }[];
}

export interface UiState {
  platform: string;
  locale: string;
  profiles: Profile[];
  currentProfileId: string;
  tabs: TabView[];
  activeTabId: string | null;
  settings: SettingsData;
  local: LocalSettings;
  sync: SyncStatus;
  providers: ProviderStatus[];
}

export interface Suggestion {
  kind: 'tab' | 'history' | 'archived';
  id?: string;
  url: string;
  title: string;
  faviconUrl?: string | null;
}

export interface AiEvent {
  chatId: string;
  text: string;
  done: boolean;
  error: string | null;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Commands pushed from the main process (menu accelerators) to the chrome UI. */
export type UiCommand = 'command-bar' | 'focus-url' | 'toggle-ai' | 'find' | 'settings' | 'archive' | { pairingLink: string };

export const ARCHIVE_OPTIONS = [
  { ms: 12 * 3600_000, key: '12h' },
  { ms: 24 * 3600_000, key: '24h' },
  { ms: 7 * 86400_000, key: '7d' },
  { ms: 30 * 86400_000, key: '30d' },
  { ms: 0, key: 'never' },
] as const;

export const SLEEP_OPTIONS = [
  { ms: 10 * 60_000, key: '10m' },
  { ms: 30 * 60_000, key: '30m' },
  { ms: 2 * 3600_000, key: '2h' },
  { ms: 0, key: 'never' },
] as const;

export const PROFILE_COLORS = ['#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#3b82f6', '#06b6d4', '#10b981', '#64748b'];
