import { useEffect, useRef, useState } from 'preact/hooks';
import { integrationFor } from '../shared/integrations.ts';
import type { ChatMessage, UiState } from '../shared/types.ts';
import { api } from './api.ts';
import { getLang, t } from './i18n.ts';
import { Favicon, Icon } from './icons.tsx';
import { Markdown } from './markdown.tsx';

export interface Chat {
  messages: ChatMessage[];
  streaming: { chatId: string; text: string } | null;
  error: string | null;
}

interface Props {
  state: UiState;
  chat: Chat;
  onSend: (text: string, tabIds: string[]) => void;
  onStop: () => void;
  onNew: () => void;
  onClose: () => void;
  onSettings: () => void;
}

export function AiPanel({ state, chat, onSend, onStop, onNew, onClose, onSettings }: Props) {
  const [text, setText] = useState('');
  const [usePage, setUsePage] = useState(true);
  const [extra, setExtra] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const active = state.tabs.find((x) => x.id === state.activeTabId) ?? null;
  const available = state.providers.filter((p) => p.available);
  const provider = available.find((p) => p.id === state.local.aiProvider) ?? available[0] ?? null;
  const extras = extra.filter((id) => id !== active?.id && state.tabs.some((x) => x.id === id));

  useEffect(() => {
    if (provider && provider.id !== state.local.aiProvider) api.invoke('local.update', { aiProvider: provider.id });
  }, [provider?.id]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.messages.length, chat.streaming?.text, chat.error]);

  useEffect(() => input.current?.focus(), []);

  const submit = (value: string, tabIds?: string[]) => {
    const v = value.trim();
    if (!v || chat.streaming || !provider) return;
    onSend(v, tabIds ?? [...(usePage && active ? [active.id] : []), ...extras]);
    setText('');
  };

  const lang = getLang();
  const site = active ? integrationFor(active.url) : null;
  const ideas: { label: string; tabIds?: string[] }[] = [
    ...(site?.prompts.filter((p) => !p.match || p.match.test(active!.url)).slice(0, 2).map((p) => ({ label: p[lang] })) ?? []),
    ...(active ? [{ label: t('pSummarize') }, { label: t('pKeyPoints') }] : []),
    ...(state.tabs.length > 1 ? [{ label: t('pCompare'), tabIds: state.tabs.slice(0, 6).map((x) => x.id) }] : []),
  ].slice(0, 4);

  const open = (url: string) => api.invoke('tab.new', { input: url });

  return (
    <aside class="ai" data-testid="ai-panel">
      <header>
        <span class="ai-title">
          <Icon name="spark" size={15} />
          {available.length > 1 ? (
            <select value={provider?.id} onChange={(e) => api.invoke('local.update', { aiProvider: (e.target as HTMLSelectElement).value })}>
              {available.map((p) => <option value={p.id}>{p.label}</option>)}
            </select>
          ) : (
            <span>{provider?.label ?? t('assistant')}</span>
          )}
        </span>
        <span class="grow" />
        <button class="icon" title={t('newChat')} onClick={onNew}><Icon name="compose" /></button>
        <button class="icon" title={t('close')} onClick={onClose}><Icon name="close" /></button>
      </header>

      <div class="ai-scroll" ref={scroller}>
        {!provider ? (
          <div class="ai-empty">
            <h3>{t('aiNoProvider')}</h3>
            <p>{t('aiNoProviderHint')}</p>
            {state.providers.map((p) => (
              <div class="hint-card" key={p.id}>
                <strong>{p.label}</strong> <span class="muted">{p.subscription}</span>
                <code>{p.installHint}</code>
              </div>
            ))}
            <div class="row">
              <button class="btn" onClick={() => api.invoke('ai.detect')}>{t('redetect')}</button>
              <button class="btn ghost" onClick={onSettings}>{t('settings')}</button>
            </div>
          </div>
        ) : chat.messages.length === 0 && !chat.streaming ? (
          <div class="ai-empty">
            <h3>{active ? t('aiEmptyTitle') : t('aiEmptyTitlePlain')}</h3>
            {active && <p>{active.title || active.url}</p>}
            <div class="ideas">
              {ideas.map((i) => (
                <button key={i.label} data-testid="ai-idea" onClick={() => submit(i.label, i.tabIds)}>{i.label}</button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {chat.messages.map((m, i) => (
              <div key={i} class={`msg ${m.role}`}>{m.role === 'user' ? m.content : <Markdown text={m.content} open={open} />}</div>
            ))}
            {chat.streaming && (
              <div class="msg assistant" data-testid="ai-streaming">
                {chat.streaming.text ? <Markdown text={chat.streaming.text} open={open} /> : <span class="dots"><i /><i /><i /></span>}
              </div>
            )}
            {chat.error && <div class="msg error" data-testid="ai-error">{chat.error}</div>}
          </>
        )}
      </div>

      {provider && (
        <footer>
          {picking && (
            <div class="picker">
              {state.tabs.filter((x) => x.id !== active?.id).map((x) => (
                <label key={x.id}>
                  <input type="checkbox" checked={extra.includes(x.id)} onChange={() => setExtra(extra.includes(x.id) ? extra.filter((e) => e !== x.id) : [...extra, x.id])} />
                  <Favicon url={x.faviconUrl} page={x.url} size={12} />
                  <span class="grow">{x.title || x.url}</span>
                  {x.asleep && <span class="muted">{t('asleep')}</span>}
                </label>
              ))}
            </div>
          )}
          <div class="composer">
            {(active || extras.length > 0) && (
              <div class="chips">
                {active && (
                  <button class={`chip ${usePage ? 'on' : ''}`} title={active.title} onClick={() => setUsePage(!usePage)}>
                    <span class="chip-ico"><Favicon url={active.faviconUrl} page={active.url} size={16} /></span>
                    <span class="chip-text"><b>{active.title || t('thisPage')}</b><i>{hostOf(active.url)}</i></span>
                  </button>
                )}
                {extras.map((id) => {
                  const x = state.tabs.find((y) => y.id === id)!;
                  return (
                    <button key={id} class="chip on" title={x.title} onClick={() => setExtra(extra.filter((e) => e !== id))}>
                      <span class="chip-ico"><Favicon url={x.faviconUrl} page={x.url} size={16} /></span>
                      <span class="chip-text"><b>{x.title || x.url}</b><i>{hostOf(x.url)}</i></span>
                      <Icon name="close" size={10} />
                    </button>
                  );
                })}
              </div>
            )}
            <textarea
              ref={input}
              data-testid="ai-input"
              rows={2}
              placeholder={active && usePage ? t('askPage') : t('askPlain')}
              value={text}
              onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) (e.preventDefault(), submit(text));
              }}
            />
            <div class="composer-row">
              {state.tabs.length > (active ? 1 : 0) && (
                <button class="icon" title={t('addTabs')} onClick={() => setPicking(!picking)}><Icon name="plus" /></button>
              )}
              <span class="grow" />
              {chat.streaming ? (
                <button class="send stop" title={t('stop')} onClick={onStop}><Icon name="square" size={14} /></button>
              ) : (
                <button class="send" title={t('send')} disabled={!text.trim()} onClick={() => submit(text)}><Icon name="up" size={15} /></button>
              )}
            </div>
          </div>
        </footer>
      )}
    </aside>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
