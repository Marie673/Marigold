import { useEffect, useState } from 'preact/hooks';
import type { ArchivedTab } from '../shared/types.ts';
import { api } from './api.ts';
import { getLang, t } from './i18n.ts';
import { Favicon, Icon } from './icons.tsx';

function ago(ms: number): string {
  const rtf = new Intl.RelativeTimeFormat(getLang(), { numeric: 'auto' });
  const min = Math.round((ms - Date.now()) / 60_000);
  if (Math.abs(min) < 60) return rtf.format(min, 'minute');
  if (Math.abs(min) < 60 * 24) return rtf.format(Math.round(min / 60), 'hour');
  return rtf.format(Math.round(min / 1440), 'day');
}

export function ArchiveView({ onClose }: { onClose: () => void }) {
  const [tabs, setTabs] = useState<ArchivedTab[] | null>(null);
  const [filter, setFilter] = useState('');
  const load = () => api.invoke<ArchivedTab[]>('archive.list').then(setTabs);
  useEffect(() => void load(), []);
  const f = filter.trim().toLowerCase();
  const shown = (tabs ?? []).filter((x) => !f || x.title.toLowerCase().includes(f) || x.url.toLowerCase().includes(f));

  return (
    <div class="modal narrow" data-testid="archive">
      <header>
        <h1>{t('archiveTitle')}</h1>
        <button class="icon" onClick={onClose}><Icon name="close" /></button>
      </header>
      <div class="modal-body">
        {tabs && tabs.length === 0 ? (
          <p class="empty">{t('archiveEmpty')}</p>
        ) : (
          <>
            <div class="row">
              <input class="grow" autofocus placeholder={t('archiveFilter')} value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
              <button class="btn danger" onClick={() => api.invoke('archive.clear').then(load)}>{t('clearAll')}</button>
            </div>
            <div class="list">
              {shown.map((x) => (
                <div key={x.id} class="list-row" data-testid="archived-tab">
                  <button class="list-main" title={t('restore')} onClick={() => (api.invoke('tab.restore', x.id), onClose())}>
                    <Favicon url={x.faviconUrl} page={x.url} />
                    <span class="grow">
                      <span class="ti">{x.title || x.url}</span>
                      <span class="su">{x.url.replace(/^https?:\/\/(www\.)?/, '')}</span>
                    </span>
                    <span class="when">{ago(x.archivedAt ?? 0)}</span>
                  </button>
                  <button class="icon small" title={t('delete')} onClick={() => api.invoke('tab.delete', x.id).then(load)}><Icon name="trash" size={14} /></button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
