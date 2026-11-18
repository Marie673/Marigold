import qrcode from 'qrcode-generator';
import { useEffect, useState } from 'preact/hooks';
import { ARCHIVE_OPTIONS, BUDGET_OPTIONS, PROFILE_COLORS, SLEEP_OPTIONS, type MemoryReport, type UiState } from '../shared/types.ts';
import { api } from './api.ts';
import { getLang, t } from './i18n.ts';
import { Favicon, Icon } from './icons.tsx';

const SECTIONS = ['general', 'memory', 'profiles', 'ai', 'sync', 'shortcuts'] as const;
type Section = (typeof SECTIONS)[number];
const NAV_ICON: Record<Section, string> = { general: 'settings', memory: 'memory', profiles: 'user', ai: 'spark', sync: 'syncs', shortcuts: 'keyboard' };

export function SettingsView({ state, section, link, onClose }: { state: UiState; section?: string; link?: string; onClose: () => void }) {
  const [tab, setTab] = useState<Section>((SECTIONS as readonly string[]).includes(section ?? '') ? (section as Section) : 'general');
  return (
    <div class="modal" data-testid="settings">
      <header>
        <h1>{t('settings')}</h1>
        <button class="icon" onClick={onClose}><Icon name="close" /></button>
      </header>
      <div class="settings">
        <nav>
          {SECTIONS.map((s) => (
            <button key={s} class={s === tab ? 'on' : ''} data-testid={`settings-${s}`} onClick={() => setTab(s)}><Icon name={NAV_ICON[s]} size={15} /> {t(s)}</button>
          ))}
        </nav>
        <div class="modal-body">
          <h2 class="section-title">{t(tab)}</h2>
          {tab === 'general' && <General state={state} />}
          {tab === 'memory' && <Memory state={state} />}
          {tab === 'profiles' && <Profiles state={state} />}
          {tab === 'ai' && <Ai state={state} />}
          {tab === 'sync' && <Sync state={state} link={link} />}
          {tab === 'shortcuts' && <Shortcuts mac={state.platform === 'darwin'} />}
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, icon, tone, children }: { label: string; hint?: string; icon?: string; tone?: string; children: preact.ComponentChildren }) {
  return (
    <div class="field">
      {icon && <span class="field-ico" style={{ background: tone }}><Icon name={icon} size={13} /></span>}
      <div class="field-text">
        <label>{label}</label>
        {hint && <p class="hint">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

const gb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GB` : `${mb} MB`);

function Memory({ state }: { state: UiState }) {
  const [m, setM] = useState<MemoryReport | null>(null);
  useEffect(() => {
    const load = () => api.invoke<MemoryReport>('memory.get').then(setM);
    load();
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, []);
  const budget = m && m.budgetMb > 0 ? m.budgetMb : null;
  return (
    <>
      <div class="group">
        <div class="mem-head" data-testid="memory-total">
          <div>
            <span class="mem-big">{m ? gb(m.totalMb) : '—'}</span>
            <span class="muted"> {budget ? `/ ${gb(budget)}` : ''}</span>
          </div>
          <span class="muted">{t('memTotal')}</span>
        </div>
        {m && (
          <div class="meter">
            <i class="base" style={{ width: `${Math.min(100, (m.baseMb / (budget ?? Math.max(m.totalMb, 1))) * 100)}%` }} />
            <i style={{ width: `${Math.min(100, ((m.totalMb - m.baseMb) / (budget ?? Math.max(m.totalMb, 1))) * 100)}%` }} />
          </div>
        )}
        {m && (
          <div class="mem-legend">
            <span><i class="dot base" /> {t('memBase')} {gb(m.baseMb)}</span>
            <span><i class="dot" /> {t('memAwake')} {m.tabs.length} · {gb(m.totalMb - m.baseMb)}</span>
            <span>{t('memAsleep')} {m.asleep}</span>
          </div>
        )}
      </div>
      <div class="group">
        <Field icon="gauge" tone="#3b82f6" label={t('memBudget')} hint={t('memBudgetHint')}>
          <select value={state.local.memoryBudgetMb} onChange={(e) => api.invoke('local.update', { memoryBudgetMb: Number((e.target as HTMLSelectElement).value) })}>
            {BUDGET_OPTIONS.map((b) => <option value={b}>{b === 0 ? `${t('memAuto')}${m && state.local.memoryBudgetMb === 0 ? ` (${gb(m.budgetMb)})` : ''}` : b < 0 ? t('memNoLimit') : gb(b)}</option>)}
          </select>
        </Field>
        <Field icon="moon" tone="#8b5cf6" label={t('sleepAfter')} hint={t('sleepAfterHint')}>
          <select value={state.local.sleepAfterMs} onChange={(e) => api.invoke('local.update', { sleepAfterMs: Number((e.target as HTMLSelectElement).value) })}>
            {SLEEP_OPTIONS.map((o) => <option value={o.ms}>{t(`o${o.key}` as 'o5m')}</option>)}
          </select>
        </Field>
      </div>
      <div class="group-head">
        <h3>{t('memAwake')}</h3>
        <button class="btn ghost" disabled={!m || m.tabs.filter((x) => !x.active).length === 0} onClick={() => api.invoke('memory.sleep', null)}>{t('memSleepAll')}</button>
      </div>
      <div class="group">
        {m && m.tabs.length === 0 && <p class="empty">{t('memNone')}</p>}
        {m?.tabs.map((x) => (
          <div class="mem-row" key={x.id}>
            <Favicon url={x.faviconUrl} page={x.url} />
            <span class="grow">{x.title}</span>
            <span class="mem-mb">{x.mb ? gb(x.mb) : '—'}</span>
            <button class="btn ghost" disabled={x.active} onClick={() => api.invoke('memory.sleep', x.id)}>{t('memSleep')}</button>
          </div>
        ))}
      </div>
    </>
  );
}

function General({ state }: { state: UiState }) {
  const [cleared, setCleared] = useState(false);
  return (
    <>
      <div class="group">
        <Field icon="archive" tone="#f59e0b" label={t('archiveAfter')} hint={t('archiveAfterHint')}>
          <select data-testid="archive-after" value={state.settings.archiveAfterMs} onChange={(e) => api.invoke('settings.update', { archiveAfterMs: Number((e.target as HTMLSelectElement).value) })}>
            {ARCHIVE_OPTIONS.map((o) => <option value={o.ms}>{t(`o${o.key}` as 'o12h')}</option>)}
          </select>
        </Field>
      </div>
      <div class="group">
        <Field icon="search" tone="#10b981" label={t('searchEngine')}>
          <select value={state.settings.searchEngine} onChange={(e) => api.invoke('settings.update', { searchEngine: (e.target as HTMLSelectElement).value })}>
            <option value="google">Google</option>
            <option value="duckduckgo">DuckDuckGo</option>
            <option value="bing">Bing</option>
          </select>
        </Field>
        <Field icon="clock" tone="#ef4444" label={t('clearHistory')}>
          <button class="btn ghost" onClick={() => api.invoke('history.clear').then(() => setCleared(true))}>{cleared ? t('cleared') : t('delete')}</button>
        </Field>
      </div>
    </>
  );
}

function Profiles({ state }: { state: UiState }) {
  return (
    <>
      <p class="hint">{t('profileHint')}</p>
      <div class="group">
      {state.profiles.map((p) => (
        <div class="profile-row" key={p.id} data-testid="profile-row">
          <input class="emoji-input" value={p.icon} onChange={(e) => api.invoke('profile.update', { id: p.id, icon: (e.target as HTMLInputElement).value.trim().slice(0, 8) || '🌼' })} />
          <input class="grow" value={p.name} placeholder={t('name')} onChange={(e) => api.invoke('profile.update', { id: p.id, name: (e.target as HTMLInputElement).value.slice(0, 40) || p.name })} />
          <div class="swatches">
            {PROFILE_COLORS.map((c) => (
              <button key={c} class={c === p.color ? 'on' : ''} style={{ background: c }} onClick={() => api.invoke('profile.update', { id: p.id, color: c })} />
            ))}
          </div>
          {p.id === state.currentProfileId ? (
            <span class="tag">{t('current')}</span>
          ) : (
            <button class="btn ghost" onClick={() => api.invoke('profile.switch', p.id)}>{t('switchTo')}</button>
          )}
          <button class="icon small" title={t('delete')} disabled={state.profiles.length < 2} onClick={() => api.invoke('profile.delete', p.id)}><Icon name="trash" size={14} /></button>
        </div>
      ))}
      </div>
      <div class="row">
        <button
          class="btn"
          data-testid="add-profile"
          onClick={() => {
            const used = state.profiles.map((p) => p.color);
            const color = PROFILE_COLORS.find((c) => !used.includes(c)) ?? PROFILE_COLORS[0];
            api.invoke('profile.create', { name: getLang() === 'ja' ? '仕事' : 'Work', color, icon: '💼', order: 0 });
          }}
        >
          <Icon name="plus" size={14} /> {t('addProfile')}
        </button>
      </div>
    </>
  );
}

function Ai({ state }: { state: UiState }) {
  return (
    <>
      <p class="hint">{t('aiHint')}</p>
      {state.providers.map((p) => (
        <div class="card" key={p.id} data-testid={`provider-${p.id}`}>
          <div class="card-head">
            <strong>{p.label}</strong>
            <span class="muted">{p.subscription}</span>
            <span class={`tag ${p.available ? 'ok' : 'bad'}`}>{p.available ? t('detected') : t('notFound')}</span>
            <span class="grow" />
            {p.available && (state.local.aiProvider === p.id ? <span class="tag">{t('inUse')}</span> : <button class="btn ghost" onClick={() => api.invoke('local.update', { aiProvider: p.id })}>{t('useThis')}</button>)}
          </div>
          {p.available ? (
            <p class="muted mono">{p.path} · {p.version}</p>
          ) : (
            <p class="muted">{t('install')}: <code>{p.installHint}</code></p>
          )}
          <div class="row">
            <label class="mini">{t('model')}</label>
            <input
              class="grow"
              placeholder={t('modelPlaceholder')}
              value={state.local.aiModels[p.id] ?? ''}
              onChange={(e) => api.invoke('local.update', { aiModels: { ...state.local.aiModels, [p.id]: (e.target as HTMLInputElement).value.trim() } })}
            />
          </div>
          <div class="row">
            <label class="mini">{t('cliPath')}</label>
            <input
              class="grow mono"
              placeholder={p.path ?? ''}
              value={state.local.cliPaths[p.id] ?? ''}
              onChange={(e) => api.invoke('local.update', { cliPaths: { ...state.local.cliPaths, [p.id]: (e.target as HTMLInputElement).value.trim() } })}
            />
          </div>
        </div>
      ))}
      <div class="row"><button class="btn ghost" onClick={() => api.invoke('ai.detect')}>{t('redetect')}</button></div>
    </>
  );
}

function Qr({ text }: { text: string }) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  return (
    <svg class="qr" viewBox={`-2 -2 ${n + 4} ${n + 4}`} shape-rendering="crispEdges">
      <rect x="-2" y="-2" width={n + 4} height={n + 4} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

function Sync({ state, link }: { state: UiState; link?: string }) {
  const s = state.sync;
  const [server, setServer] = useState('');
  const [join, setJoin] = useState(link ?? '');
  const [pair, setPair] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (s.state !== 'off') api.invoke<string | null>('sync.link').then(setPair);
    else setPair(null);
  }, [s.state === 'off']);

  const run = async (name: string, arg: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.invoke(name, arg);
    } catch (e) {
      setError(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
    setBusy(false);
  };

  if (s.state === 'off') {
    return (
      <>
        <p class="hint">{t('syncHint')}</p>
        <div class="card">
          <label class="mini">{t('syncServer')}</label>
          <div class="row">
            <input class="grow mono" data-testid="sync-server" placeholder="https://sync.example.com" value={server} onInput={(e) => setServer((e.target as HTMLInputElement).value)} />
            <button class="btn" data-testid="sync-create" disabled={busy || !server.trim()} onClick={() => run('sync.create', server)}>{t('syncCreate')}</button>
          </div>
        </div>
        <div class="card">
          <label class="mini">{link ? t('joinConfirm') : t('syncJoinLabel')}</label>
          <div class="row">
            <input class="grow mono" type="password" data-testid="sync-link" placeholder="marigold://sync?…" value={join} onInput={(e) => setJoin((e.target as HTMLInputElement).value)} />
            <button class="btn" data-testid="sync-join" disabled={busy || !join.trim()} onClick={() => run('sync.join', join)}>{t('syncJoin')}</button>
          </div>
        </div>
        {error && <p class="error" data-testid="sync-error">{error}</p>}
      </>
    );
  }

  const label = s.state === 'ok' ? t('syncOk') : s.state === 'connecting' ? t('syncConnecting') : t('syncError');
  return (
    <>
      <div class="card">
        <div class="card-head">
          <span class={`tag ${s.state === 'ok' ? 'ok' : s.state === 'error' ? 'bad' : ''}`} data-testid="sync-state">{label}</span>
          <span class="mono muted">{s.server}</span>
          <span class="grow" />
          {s.lastSyncAt && <span class="muted">{t('lastSync')}: {new Date(s.lastSyncAt).toLocaleTimeString()}</span>}
        </div>
        {s.error && <p class="error">{s.error}</p>}
        <div class="row">
          <label class="mini">{t('deviceName')}</label>
          <input class="grow" value={state.local.deviceName} onChange={(e) => api.invoke('local.update', { deviceName: (e.target as HTMLInputElement).value.slice(0, 40) })} />
        </div>
      </div>
      <div class="card">
        <strong>{t('pairing')}</strong>
        <p class="hint">{t('pairingHint')}</p>
        {pair && (
          <div class="pair">
            <Qr text={pair} />
            <button class="btn ghost" onClick={() => navigator.clipboard.writeText(pair).then(() => setCopied(true))}>{copied ? t('copied') : t('copyLink')}</button>
          </div>
        )}
      </div>
      <div class="card">
        <strong>{t('devices')}</strong>
        {s.devices.map((d) => (
          <div class="device" key={d.id}>
            <span>{d.platform === 'ios' ? '📱' : '💻'}</span>
            <span class="grow">{d.name}</span>
            {d.self && <span class="tag">{t('thisDevice')}</span>}
          </div>
        ))}
      </div>
      <div class="row"><button class="btn danger" data-testid="sync-disconnect" onClick={() => api.invoke('sync.disconnect')}>{t('disconnect')}</button></div>
    </>
  );
}

function Shortcuts({ mac }: { mac: boolean }) {
  const m = mac ? '⌘' : 'Ctrl+';
  const ja = getLang() === 'ja';
  const rows: [string, string][] = [
    [`${m}T`, ja ? '新しいタブ（コマンドバー）' : 'New tab (command bar)'],
    [`${m}L`, ja ? 'URLを編集' : 'Edit address'],
    [`${m}E`, ja ? 'アシスタントを開閉' : 'Toggle assistant'],
    ['⇧↵', ja ? 'コマンドバーの入力をAIに聞く' : 'Ask the assistant from the command bar'],
    [`${m}W`, ja ? 'タブを閉じる（アーカイブへ）' : 'Close tab (to archive)'],
    [`${m}⇧T`, ja ? '閉じたタブを復元' : 'Reopen closed tab'],
    [`${m}D`, ja ? 'ピン留め / 解除' : 'Pin / unpin'],
    [`${m}Y`, ja ? 'アーカイブを開く' : 'Open archive'],
    [`${m}1–9`, ja ? 'タブを番号で選択' : 'Select tab by number'],
    ['Ctrl+Tab', ja ? '次のタブ' : 'Next tab'],
    [`${m}F`, ja ? 'ページ内検索' : 'Find in page'],
    [`${m},`, ja ? '設定' : 'Settings'],
  ];
  return (
    <table class="keys">
      <tbody>{rows.map(([k, d]) => <tr><td><kbd>{k}</kbd></td><td>{d}</td></tr>)}</tbody>
    </table>
  );
}
