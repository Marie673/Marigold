import { render } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ChatMessage, Profile, TabView, UiState } from '../shared/types.ts';
import { AiPanel, type Chat } from './aipanel.tsx';
import { api } from './api.ts';
import { ArchiveView } from './archive.tsx';
import { CommandBar } from './commandbar.tsx';
import { setLocale, t } from './i18n.ts';
import { Favicon, Icon } from './icons.tsx';
import { SettingsView } from './settings.tsx';
import { StartPage } from './startpage.tsx';

type Overlay =
  | { kind: 'command'; mode: 'new' | 'edit'; initial: string }
  | { kind: 'profiles' }
  | { kind: 'settings'; section?: string; link?: string }
  | { kind: 'archive' }
  | null;

const rid = () => Math.random().toString(36).slice(2, 12);

function App({ initial }: { initial: UiState }) {
  const [state, setState] = useState(initial);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [shot, setShot] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  const [chat, setChat] = useState<Chat>({ messages: [], streaming: null, error: null });
  const [sidebar, setSidebarState] = useState(() => {
    try {
      return localStorage.getItem('sidebar') !== '0';
    } catch {
      return true;
    }
  });
  const setSidebar = (on: boolean) => {
    setSidebarState(on);
    try {
      localStorage.setItem('sidebar', on ? '1' : '0');
    } catch {}
  };
  const prevTab = useRef<string | null>(null);
  const openBarRef = useRef<() => void>(() => {});
  const contentRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const chatRef = useRef(chat);
  chatRef.current = chat;

  const active = state.tabs.find((x) => x.id === state.activeTabId) ?? null;
  const profile = state.profiles.find((p) => p.id === state.currentProfileId) ?? state.profiles[0];
  const aiOpen = state.local.aiPanelOpen;

  const setAiOpen = useCallback((open: boolean) => api.invoke('local.update', { aiPanelOpen: open }), []);

  const send = useCallback((text: string, tabIds: string[]) => {
    const chatId = rid();
    const messages: ChatMessage[] = [...chatRef.current.messages, { role: 'user', content: text }];
    setChat({ messages, streaming: { chatId, text: '' }, error: null });
    api.invoke('ai.send', { chatId, messages, tabIds });
  }, []);

  useEffect(() => {
    const offs = [
      api.on('state', setState),
      api.on('ai', (e) => {
        setChat((c) => {
          if (c.streaming?.chatId !== e.chatId) return c;
          if (!e.done) return { ...c, streaming: { chatId: e.chatId, text: e.text } };
          const messages = e.text ? [...c.messages, { role: 'assistant' as const, content: e.text }] : c.messages;
          return { messages, streaming: null, error: e.error };
        });
      }),
      api.on('command', (c) => {
        const s = stateRef.current;
        const cur = s.tabs.find((x) => x.id === s.activeTabId);
        if (c === 'command-bar' || (c === 'focus-url' && !cur)) openBarRef.current();
        else if (c === 'focus-url') setOverlay({ kind: 'command', mode: 'edit', initial: cur!.url });
        else if (c === 'toggle-ai') setAiOpen(!s.local.aiPanelOpen);
        else if (c === 'find') cur && setFinding(true);
        else if (c === 'settings') setOverlay({ kind: 'settings' });
        else if (c === 'archive') setOverlay({ kind: 'archive' });
        else if (typeof c === 'object') setOverlay({ kind: 'settings', section: 'sync', link: c.pairingLink });
      }),
    ];
    api.invoke('ui.ready');
    return () => offs.forEach((off) => off());
  }, []);

  // Tell the main process where the page goes.
  useLayoutEffect(() => {
    const el = contentRef.current!;
    const report = () => {
      const r = el.getBoundingClientRect();
      api.invoke('layout.bounds', { x: r.x, y: r.y, width: r.width, height: r.height });
    };
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener('resize', report);
    report();
    return () => (ro.disconnect(), window.removeEventListener('resize', report));
  }, []);

  // Popovers live below the page view, so the page is swapped for a screenshot while one is open.
  const hasOverlay = overlay !== null;
  useEffect(() => {
    let live = true;
    api.invoke<string | null>('overlay.set', hasOverlay).then((s) => live && setShot(hasOverlay ? s : null));
    return () => void (live = false);
  }, [hasOverlay]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (overlay) setOverlay(null);
      else if (finding) setFinding(false);
      else if (!active && prevTab.current && state.tabs.some((x) => x.id === prevTab.current)) api.invoke('tab.activate', prevTab.current);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlay, finding, active?.id, state.tabs]);

  useEffect(() => {
    if (!active) setFinding(false);
    else setOverlay((o) => (o?.kind === 'command' ? null : o));
  }, [active?.id]);

  const ask = (q: string) => {
    setOverlay(null);
    setAiOpen(true);
    send(q, active ? [active.id] : []);
  };

  const mac = state.platform === 'darwin';
  const openBar = () => {
    // A new tab is the "ask anything" page; Escape returns to where you were.
    if (active) prevTab.current = active.id;
    setOverlay(null);
    if (active) api.invoke('tab.activate', null);
    else document.querySelector<HTMLInputElement>('[data-testid=command-input]')?.focus();
  };
  openBarRef.current = openBar;
  return (
    <div class={`app ${mac ? 'mac' : ''} ${sidebar ? '' : 'collapsed'}`} style={{ '--accent': profile.color }}>
      {sidebar && (
        <Sidebar state={state} profile={profile} onProfiles={() => setOverlay({ kind: 'profiles' })} onNew={openBar} onArchive={() => setOverlay({ kind: 'archive' })} onSettings={() => setOverlay({ kind: 'settings' })} />
      )}
      <div class="main">
        <div class="toolbar">
          <button class="icon" title={t('sidebar')} onClick={() => setSidebar(!sidebar)}><Icon name="sidebar" /></button>
          <button class="icon" title={t('back')} disabled={!active?.canGoBack} onClick={() => api.invoke('nav.back')}><Icon name="back" /></button>
          <button class="icon" title={t('forward')} disabled={!active?.canGoForward} onClick={() => api.invoke('nav.forward')}><Icon name="forward" /></button>
          <button class="icon" title={active?.loading ? t('stop') : t('reload')} disabled={!active} onClick={() => api.invoke(active?.loading ? 'nav.stop' : 'nav.reload')}>
            <Icon name={active?.loading ? 'close' : 'reload'} />
          </button>
          {finding ? (
            <FindBar onClose={() => setFinding(false)} />
          ) : (
            <button class="url" data-testid="url" onClick={() => (active ? setOverlay({ kind: 'command', mode: 'edit', initial: active.url }) : openBar())}>
              {active ? <UrlText url={active.url} title={active.title} /> : <span class="placeholder">{t('newTab')}</span>}
            </button>
          )}
          <button class={`icon ${active?.pinned ? 'on' : ''}`} title={active?.pinned ? t('unpin') : t('pin')} disabled={!active} onClick={() => active && api.invoke('tab.pin', { id: active.id, pinned: !active.pinned })}>
            <Icon name="pin" />
          </button>
<button class={`icon ${aiOpen ? 'on' : ''}`} data-testid="ai-toggle" title={`${t('assistant')} (${mac ? '⌘' : 'Ctrl+'}E)`} onClick={() => setAiOpen(!aiOpen)}>
            <Icon name="spark" />
          </button>
        </div>
        <div class="body">
          <div class="content" ref={contentRef}>
            {!active && <StartPage state={state} onAsk={ask} />}
            {shot && <img class="shot" src={shot} />}
            {overlay && <div class="scrim" onMouseDown={() => setOverlay(null)} />}
            {overlay?.kind === 'command' && <CommandBar state={state} mode={overlay.mode} initial={overlay.initial} onClose={() => setOverlay(null)} onAsk={ask} />}
            {overlay?.kind === 'profiles' && <ProfileMenu state={state} onClose={() => setOverlay(null)} onManage={() => setOverlay({ kind: 'settings', section: 'profiles' })} />}
            {overlay?.kind === 'settings' && <SettingsView state={state} section={overlay.section} link={overlay.link} onClose={() => setOverlay(null)} />}
            {overlay?.kind === 'archive' && <ArchiveView onClose={() => setOverlay(null)} />}
          </div>
          {aiOpen && (
            <AiPanel
              state={state}
              chat={chat}
              onSend={send}
              onStop={() => chat.streaming && api.invoke('ai.stop', chat.streaming.chatId)}
              onNew={() => {
                if (chat.streaming) api.invoke('ai.stop', chat.streaming.chatId);
                setChat({ messages: [], streaming: null, error: null });
              }}
              onClose={() => setAiOpen(false)}
              onSettings={() => setOverlay({ kind: 'settings', section: 'ai' })}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function UrlText({ url, title }: { url: string; title: string }) {
  try {
    const u = new URL(url);
    const rest = (u.pathname === '/' ? '' : u.pathname) + u.search;
    return (
      <span class="urltext">
        {u.protocol !== 'https:' && <span class="scheme">{u.protocol}//</span>}
        <span class="host">{u.host.replace(/^www\./, '')}</span>
        <span class="path"> / {title || (rest.length > 80 ? `${rest.slice(0, 80)}…` : rest)}</span>
      </span>
    );
  } catch {
    return <span class="urltext">{url}</span>;
  }
}

function FindBar({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<{ matches: number; active: number } | null>(null);
  useEffect(() => api.on('found', setResult), []);
  useEffect(() => () => void api.invoke('find.stop'), []);
  const run = (value: string, next: boolean, forward = true) => {
    if (!value) setResult(null);
    api.invoke('find.start', { text: value, next, forward });
  };
  return (
    <div class="find">
      <Icon name="search" size={14} />
      <input
        autofocus
        placeholder={t('find')}
        value={text}
        onInput={(e) => {
          const v = (e.target as HTMLInputElement).value;
          setText(v);
          run(v, false);
        }}
        onKeyDown={(e) => e.key === 'Enter' && run(text, true, !e.shiftKey)}
      />
      {result && text && <span class="count">{result.active}/{result.matches}</span>}
      <button class="icon small" onClick={() => run(text, true, false)}><Icon name="back" size={14} /></button>
      <button class="icon small" onClick={() => run(text, true, true)}><Icon name="forward" size={14} /></button>
      <button class="icon small" onClick={onClose}><Icon name="close" size={14} /></button>
    </div>
  );
}

function Sidebar({ state, profile, onProfiles, onNew, onArchive, onSettings }: { state: UiState; profile: Profile; onProfiles: () => void; onNew: () => void; onArchive: () => void; onSettings: () => void }) {
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const pinned = state.tabs.filter((x) => x.pinned);
  const open = state.tabs.filter((x) => !x.pinned);

  const drop = (target: TabView | null, toPinned: boolean) => {
    const id = drag;
    setDrag(null);
    setOver(null);
    const tab = state.tabs.find((x) => x.id === id);
    if (!tab || tab.id === target?.id) return;
    const move = () => api.invoke('tab.move', { id: tab.id, before: target?.id ?? null });
    if (tab.pinned !== toPinned) api.invoke('tab.pin', { id: tab.id, pinned: toPinned }).then(move);
    else move();
  };

  const item = (x: TabView) => (
    <div
      key={x.id}
      class={`tab ${x.pinned ? 'pinned' : ''} ${x.id === state.activeTabId ? 'active' : ''} ${x.asleep ? 'asleep' : ''} ${over === x.id ? 'over' : ''}`}
      data-testid={x.pinned ? 'pinned-tab' : 'tab'}
      title={x.title || x.url}
      draggable
      onDragStart={(e) => {
        setDrag(x.id);
        e.dataTransfer!.effectAllowed = 'move';
      }}
      onDragOver={(e) => drag && (e.preventDefault(), setOver(x.id))}
      onDragLeave={() => setOver((o) => (o === x.id ? null : o))}
      onDrop={(e) => (e.preventDefault(), e.stopPropagation(), drop(x, x.pinned))}
      onDragEnd={() => (setDrag(null), setOver(null))}
      onClick={() => api.invoke('tab.activate', x.id)}
      onAuxClick={(e) => e.button === 1 && api.invoke('tab.close', x.id)}
      onContextMenu={(e) => (e.preventDefault(), api.invoke('tab.menu', x.id))}
    >
      <span class={`fav ${x.loading ? 'loading' : ''}`}>
        <Favicon url={x.faviconUrl} page={x.url} size={x.pinned ? 18 : 16} />
        {x.badge && <span class="badge">{x.badge}</span>}
      </span>
      {!x.pinned && <span class="title">{x.title || x.url.replace(/^https?:\/\/(www\.)?/, '') || t('newTab')}</span>}
      {x.audible && <span class="sound"><Icon name="sound" size={12} /></span>}
      {!x.pinned && (
        <button class="x" title={t('close')} onClick={(e) => (e.stopPropagation(), api.invoke('tab.close', x.id))}>
          <Icon name="close" size={12} />
        </button>
      )}
    </div>
  );

  return (
    <aside class="sidebar">
      <div class="side-top">
        <button class="profile" data-testid="profile-button" onClick={onProfiles} title={profile.name}>
          <span class="pname">{profile.name}</span>
          <Icon name="chevron" size={12} />
        </button>
      </div>
      <div class={`pins ${drag ? 'dropping' : ''}`} onDragOver={(e) => drag && e.preventDefault()} onDrop={(e) => (e.preventDefault(), drop(null, true))}>
        {pinned.map(item)}
        {drag && !pinned.length && <span class="pin-drop"><Icon name="pin" size={13} /> {t('pin')}</span>}
      </div>
      <hr />
      <button class={`new-tab ${state.activeTabId ? '' : 'active'}`} data-testid="new-tab" onClick={onNew}>
        <Icon name="plus" size={15} /> <span class="grow">{t('newTab')}</span> <kbd>{state.platform === 'darwin' ? '⌘' : 'Ctrl+'}T</kbd>
      </button>
      <div class="tabs" onDragOver={(e) => drag && e.preventDefault()} onDrop={(e) => (e.preventDefault(), drop(null, false))}>
        {open.map(item)}
      </div>
      <div class="side-bottom">
        <button class="icon small" title={t('archive')} onClick={onArchive}><Icon name="archive" size={15} /></button>
        <div class="dots-nav">
          {state.profiles.map((p) => (
            <button key={p.id} class={p.id === state.currentProfileId ? 'on' : ''} title={p.name} style={{ '--c': p.color }} onClick={() => api.invoke('profile.switch', p.id)} />
          ))}
        </div>
        <button class="icon small" title={t('settings')} onClick={onSettings}><Icon name="settings" size={15} /></button>
      </div>
    </aside>
  );
}

function ProfileMenu({ state, onClose, onManage }: { state: UiState; onClose: () => void; onManage: () => void }) {
  return (
    <div class="menu profile-menu" data-testid="profile-menu">
      {state.profiles.map((p) => (
        <button
          key={p.id}
          class={p.id === state.currentProfileId ? 'current' : ''}
          onClick={() => (api.invoke('profile.switch', p.id), onClose())}
        >
          <span class="swatch" style={{ background: p.color }}>{p.icon}</span>
          <span class="grow">{p.name}</span>
          {p.id === state.currentProfileId && <Icon name="check" size={14} />}
        </button>
      ))}
      <hr />
      <button onClick={onManage}><span class="swatch plain"><Icon name="settings" size={14} /></span><span class="grow">{t('profiles')}…</span></button>
    </div>
  );
}

api.invoke<UiState>('state.get').then((initial) => {
  setLocale(initial.locale);
  document.documentElement.lang = initial.locale;
  render(<App initial={initial} />, document.getElementById('root')!);
});
