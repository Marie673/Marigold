import { useEffect, useState } from 'preact/hooks';
import { INTEGRATIONS } from '../shared/integrations.ts';
import type { ArchivedTab, UiState } from '../shared/types.ts';
import { api } from './api.ts';
import { t } from './i18n.ts';
import { CommandBar } from './commandbar.tsx';
import { Favicon } from './icons.tsx';

/** Shown when no tab is open: a prompt, apps to pin, and a way back to recent tabs. */
export function StartPage({ state, onAsk }: { state: UiState; onAsk: (q: string) => void }) {
  const [recent, setRecent] = useState<ArchivedTab[]>([]);
  useEffect(() => {
    api.invoke<ArchivedTab[]>('archive.list').then((a) => setRecent(a.slice(0, 5)));
  }, [state.currentProfileId, state.tabs.length]);
  const pinnedUrls = state.tabs.filter((x) => x.pinned).map((x) => x.url);
  const apps = INTEGRATIONS.filter((i) => !pinnedUrls.some((u) => i.hosts.test(hostOf(u))));

  return (
    <div class="start" data-testid="start-page">
      <div class="orb" />
      <CommandBar key={state.currentProfileId} state={state} mode="new" initial="" inline onClose={() => {}} onAsk={onAsk} />
      {apps.length > 0 && (
        <section>
          <h2>{t('pinApps')}</h2>
          <div class="apps">
            {apps.map((i) => (
              <button key={i.id} class="app-pin" data-testid={`pin-app-${i.id}`} onClick={() => api.invoke('tab.new', { input: i.home, pinned: true, activate: false })}>
                <span class="app-dot big" style={{ background: i.color }}>{i.name[0]}</span>
                {i.name}
              </button>
            ))}
          </div>
        </section>
      )}
      {recent.length > 0 && (
        <section>
          <h2>{t('recentlyArchived')}</h2>
          <div class="recent">
            {recent.map((x) => (
              <button key={x.id} onClick={() => api.invoke('tab.restore', x.id)}>
                <Favicon url={x.faviconUrl} page={x.url} />
                <span class="grow">{x.title || x.url}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
