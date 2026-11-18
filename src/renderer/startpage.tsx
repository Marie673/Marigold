import { useEffect, useState } from 'preact/hooks';
import { INTEGRATIONS } from '../shared/integrations.ts';
import type { ArchivedTab, UiState } from '../shared/types.ts';
import { api } from './api.ts';
import { CommandBar } from './commandbar.tsx';
import { t } from './i18n.ts';
import { Favicon, Mark } from './icons.tsx';

/** The new-tab page: one box that opens, searches or asks. */
export function StartPage({ state, onAsk }: { state: UiState; onAsk: (q: string) => void }) {
  const [recent, setRecent] = useState<ArchivedTab[]>([]);
  useEffect(() => {
    api.invoke<ArchivedTab[]>('archive.list').then((a) => setRecent(a.slice(0, 4)));
  }, [state.currentProfileId, state.tabs.length]);
  const pinnedUrls = state.tabs.filter((x) => x.pinned).map((x) => x.url);
  const apps = INTEGRATIONS.filter((i) => !pinnedUrls.some((u) => i.hosts.test(hostOf(u))));
  const hour = new Date().getHours();
  const greeting = hour < 5 ? t('gEvening') : hour < 11 ? t('gMorning') : hour < 18 ? t('gDay') : t('gEvening');

  return (
    <div class="start" data-testid="start-page">
      <Mark />
      <h1>{greeting}</h1>
      <div class="ask">
        <CommandBar key={state.currentProfileId} state={state} mode="new" initial="" inline onClose={() => {}} onAsk={onAsk} />
        {apps.length > 0 && (
          <div class="ask-apps">
            <span>{t('pinApps')}</span>
            <span class="grow" />
            {apps.map((i) => (
              <button key={i.id} class="app-tile" title={`${i.name} — ${t('pinAppsShort')}`} data-testid={`pin-app-${i.id}`} onClick={() => api.invoke('tab.new', { input: i.home, pinned: true, activate: false })}>
                <Favicon url={i.icon} page={i.home} size={16} />
              </button>
            ))}
          </div>
        )}
      </div>
      {recent.length > 0 && (
        <section>
          <h2>{t('recentlyArchived')}</h2>
          <div class="recent">
            {recent.map((x) => (
              <button key={x.id} onClick={() => api.invoke('tab.restore', x.id)}>
                <Favicon url={x.faviconUrl} page={x.url} />
                <span class="grow">{x.title || x.url}</span>
                <span class="host">{hostOf(x.url).replace(/^www\./, '')}</span>
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
