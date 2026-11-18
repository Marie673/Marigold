import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { INTEGRATIONS, matchActions } from '../shared/integrations.ts';
import { resolveInput } from '../shared/lifecycle.ts';
import type { Suggestion, UiState } from '../shared/types.ts';
import { api } from './api.ts';
import { getLang, t } from './i18n.ts';
import { Favicon, Icon } from './icons.tsx';

interface Item {
  key: string;
  icon: preact.ComponentChildren;
  title: string;
  sub?: string;
  hint: string;
  run: () => void;
}

const looksLikeQuestion = (q: string) => /[?？]$/.test(q) || (q.split(/\s+/).length >= 4 && !/^https?:/.test(q)) || /(して|とは|教えて|ですか|ますか)$/.test(q);

export function CommandBar({ state, mode, initial, onClose, onAsk, inline }: { state: UiState; mode: 'new' | 'edit'; initial: string; onClose: () => void; onAsk: (q: string) => void; inline?: boolean }) {
  const [q, setQ] = useState(initial);
  const [sel, setSel] = useState(0);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  useEffect(() => {
    let live = true;
    // The untouched current URL is not a query worth suggesting for.
    if (!q.trim() || (mode === 'edit' && q === initial)) setSuggestions([]);
    else api.invoke<Suggestion[]>('suggest', q).then((s) => live && setSuggestions(s));
    return () => void (live = false);
  }, [q]);

  const go = (input: string) => {
    api.invoke('nav.go', { id: mode === 'edit' ? state.activeTabId : null, input });
    onClose();
  };

  const items = useMemo<Item[]>(() => {
    const query = q.trim();
    const out: Item[] = [];
    if (!query) {
      if (inline) return out;
      for (const i of INTEGRATIONS.slice(0, 4)) {
        out.push({ key: `home-${i.id}`, icon: <span class="app-dot" style={{ background: i.color }}>{i.name[0]}</span>, title: i.name, sub: i.home.replace(/^https:\/\//, ''), hint: t('goTo'), run: () => go(i.home) });
      }
      return out;
    }
    const url = resolveInput(query, state.settings.searchEngine);
    const isSearch = url.includes(encodeURIComponent(query)) && !/^(https?|file|about):/i.test(query);
    const primary: Item = isSearch
      ? { key: 'search', icon: <Icon name="search" />, title: query, hint: t('searchWeb'), run: () => go(query) }
      : { key: 'url', icon: <Icon name="globe" />, title: url, hint: t('goTo'), run: () => go(query) };
    const askItem: Item = { key: 'ask', icon: <Icon name="spark" />, title: query, hint: t('askAssistant'), run: () => onAsk(query) };
    const actions = matchActions(query, getLang()).map<Item>((h) => ({
      key: `act-${h.action.id}`,
      icon: <span class="app-dot" style={{ background: h.integration.color }}>{h.integration.name[0]}</span>,
      title: h.label,
      hint: h.integration.name,
      run: () => go(h.url),
    }));
    const sugg = suggestions.map<Item>((s, i) => ({
      key: `s-${i}`,
      icon: s.kind === 'tab' ? <Favicon url={s.faviconUrl} page={s.url} /> : <Icon name="clock" />,
      title: s.title,
      sub: s.url.replace(/^https?:\/\/(www\.)?/, ''),
      hint: s.kind === 'tab' ? t('openTab') : t('history'),
      run: () => (s.kind === 'tab' && s.id ? (api.invoke('tab.activate', s.id), onClose()) : go(s.url)),
    }));
    const question = isSearch && looksLikeQuestion(query);
    out.push(...actions);
    if (question) out.push(askItem, primary);
    else out.push(primary);
    out.push(...sugg);
    if (!question) out.push(askItem);
    return out;
  }, [q, suggestions, state.settings.searchEngine, state.activeTabId, inline]);

  useEffect(() => setSel(0), [q]);
  const selected = Math.min(sel, Math.max(0, items.length - 1));

  const onKey = (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229) return; // IME: Enter confirms the conversion.
    if (e.key === 'ArrowDown') (e.preventDefault(), setSel((selected + 1) % Math.max(1, items.length)));
    else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((selected - 1 + items.length) % Math.max(1, items.length)));
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey && q.trim()) onAsk(q.trim());
      else items[selected]?.run();
    }
  };

  return (
    <div class={`cmd ${inline ? 'inline' : ''}`} data-testid="command-bar">
      <div class="cmd-input">
        <Icon name="search" size={18} />
        <input ref={input} data-testid="command-input" value={q} placeholder={inline ? t('askAnything') : t('search')} spellcheck={false} onInput={(e) => setQ((e.target as HTMLInputElement).value)} onKeyDown={onKey} />
        <kbd>⇧↵ {t('askAi')}</kbd>
      </div>
      {items.length > 0 && (
        <div class="cmd-list">
          {items.map((it, i) => (
            <button key={it.key} class={`cmd-item ${i === selected ? 'sel' : ''}`} data-testid={`cmd-${it.key}`} onMouseEnter={() => setSel(i)} onClick={it.run}>
              <span class="ic">{it.icon}</span>
              <span class="ti">{it.title}</span>
              {it.sub && <span class="su">{it.sub}</span>}
              <span class="hi">{it.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
