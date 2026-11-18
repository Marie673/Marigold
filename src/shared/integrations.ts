// Built-in knowledge of common web apps: quick actions for the command bar,
// unread badges, cleaner page extraction for the assistant, and prompt ideas.

export interface QuickAction {
  id: string;
  /** Words that surface the action in the command bar. */
  keywords: string[];
  label: { ja: string; en: string };
  /** `{q}` is replaced with the rest of the query; actions without it open directly. */
  url: string;
}

export interface Integration {
  id: string;
  name: string;
  home: string;
  hosts: RegExp;
  color: string;
  actions: QuickAction[];
  /** Extracts an unread badge from a page title. */
  badge?: (title: string) => string | null;
  /** CSS selectors (first match wins) for the main content, used for AI context. */
  contentSelectors: string[];
  prompts: { match?: RegExp; ja: string; en: string }[];
}

const count = (re: RegExp) => (title: string) => {
  const m = re.exec(title);
  return m && m[1] !== '0' ? m[1] : null;
};

export const INTEGRATIONS: Integration[] = [
  {
    id: 'github',
    name: 'GitHub',
    home: 'https://github.com/',
    hosts: /(^|\.)github\.com$/,
    color: '#24292f',
    actions: [
      { id: 'gh-search', keywords: ['gh', 'github'], label: { ja: 'GitHubで検索: {q}', en: 'Search GitHub: {q}' }, url: 'https://github.com/search?q={q}' },
      { id: 'gh-prs', keywords: ['pr', 'prs', 'pull', 'github'], label: { ja: 'GitHub: 自分のPull Request', en: 'GitHub: my pull requests' }, url: 'https://github.com/pulls' },
      { id: 'gh-reviews', keywords: ['review', 'reviews', 'github'], label: { ja: 'GitHub: レビュー依頼', en: 'GitHub: review requests' }, url: 'https://github.com/pulls/review-requested' },
      { id: 'gh-issues', keywords: ['issue', 'issues', 'github'], label: { ja: 'GitHub: 自分のIssue', en: 'GitHub: my issues' }, url: 'https://github.com/issues/assigned' },
      { id: 'gh-notif', keywords: ['notifications', 'inbox', 'github', '通知'], label: { ja: 'GitHub: 通知', en: 'GitHub: notifications' }, url: 'https://github.com/notifications' },
      { id: 'gh-new', keywords: ['new', 'repo', 'github'], label: { ja: 'GitHub: 新しいリポジトリ', en: 'GitHub: new repository' }, url: 'https://github.com/new' },
    ],
    contentSelectors: ['.js-discussion', '#diff-comparison-viewer-container', '#repo-content-turbo-frame', 'main'],
    prompts: [
      { match: /\/pull\/\d+/, ja: 'このPull Requestの変更点とレビューで見るべき所を要約して', en: 'Summarize this pull request and what a reviewer should check' },
      { match: /\/issues\/\d+/, ja: 'このIssueの議論を要約して、次のアクションを挙げて', en: 'Summarize this issue thread and list next actions' },
      { ja: 'このリポジトリが何をするものか説明して', en: 'Explain what this repository does' },
    ],
  },
  {
    id: 'gmail',
    name: 'Gmail',
    home: 'https://mail.google.com/',
    hosts: /^mail\.google\.com$/,
    color: '#ea4335',
    actions: [
      { id: 'gm-compose', keywords: ['mail', 'gmail', 'compose', 'メール', '作成'], label: { ja: 'Gmail: メールを作成', en: 'Gmail: compose' }, url: 'https://mail.google.com/mail/?view=cm&fs=1&tf=1' },
      { id: 'gm-search', keywords: ['mail', 'gmail', 'メール'], label: { ja: 'Gmailで検索: {q}', en: 'Search Gmail: {q}' }, url: 'https://mail.google.com/mail/u/0/#search/{q}' },
      { id: 'gm-inbox', keywords: ['inbox', 'gmail', '受信'], label: { ja: 'Gmail: 受信トレイ', en: 'Gmail: inbox' }, url: 'https://mail.google.com/mail/u/0/#inbox' },
    ],
    badge: count(/\((\d[\d,]*)\)/),
    contentSelectors: ['div[role="main"]'],
    prompts: [
      { ja: 'このメールを要約して、返信が必要な点を挙げて', en: 'Summarize this email and what needs a reply' },
      { ja: 'このメールへの丁寧な返信を下書きして', en: 'Draft a polite reply to this email' },
    ],
  },
  {
    id: 'notion',
    name: 'Notion',
    home: 'https://www.notion.so/',
    hosts: /(^|\.)notion\.(so|site|com)$/,
    color: '#191919',
    actions: [
      { id: 'no-new', keywords: ['notion', 'new', 'page', 'ページ', 'メモ'], label: { ja: 'Notion: 新しいページ', en: 'Notion: new page' }, url: 'https://www.notion.so/new' },
      { id: 'no-home', keywords: ['notion'], label: { ja: 'Notionを開く', en: 'Open Notion' }, url: 'https://www.notion.so/' },
    ],
    contentSelectors: ['.notion-page-content', '.notion-frame', 'main'],
    prompts: [
      { ja: 'このページの要点を箇条書きでまとめて', en: 'Summarize the key points of this page as bullets' },
      { ja: 'このページからTODOを抜き出して', en: 'Extract the to-dos from this page' },
    ],
  },
  {
    id: 'gcal',
    name: 'Google Calendar',
    home: 'https://calendar.google.com/',
    hosts: /^calendar\.google\.com$/,
    color: '#4285f4',
    actions: [
      { id: 'gc-new', keywords: ['calendar', 'event', 'cal', '予定', 'カレンダー'], label: { ja: 'カレンダー: 予定を作成 {q}', en: 'Calendar: new event {q}' }, url: 'https://calendar.google.com/calendar/render?action=TEMPLATE&text={q}' },
    ],
    contentSelectors: ['div[role="main"]'],
    prompts: [{ ja: '表示中の予定を整理して教えて', en: 'Walk me through the events shown here' }],
  },
  {
    id: 'slack',
    name: 'Slack',
    home: 'https://app.slack.com/client',
    hosts: /^app\.slack\.com$/,
    color: '#4a154b',
    actions: [{ id: 'sl-open', keywords: ['slack'], label: { ja: 'Slackを開く', en: 'Open Slack' }, url: 'https://app.slack.com/client' }],
    badge: (t) => (/^[*!]/.test(t) ? '•' : null),
    contentSelectors: ['.p-workspace__primary_view', 'div[role="main"]'],
    prompts: [{ ja: 'このチャンネルの直近の会話を要約して', en: 'Summarize the recent conversation in this channel' }],
  },
];

export function integrationFor(url: string): Integration | null {
  try {
    const host = new URL(url).hostname;
    return INTEGRATIONS.find((i) => i.hosts.test(host)) ?? null;
  } catch {
    return null;
  }
}

export interface ActionHit {
  integration: Integration;
  action: QuickAction;
  url: string;
  label: string;
}

/** Matches "gh electron", "mail", "notion" … against quick actions. */
export function matchActions(query: string, lang: 'ja' | 'en'): ActionHit[] {
  const q = query.trim();
  if (!q) return [];
  const [first, ...rest] = q.split(/\s+/);
  const head = first.toLowerCase();
  const tail = rest.join(' ');
  const hits: ActionHit[] = [];
  for (const integration of INTEGRATIONS) {
    for (const action of integration.actions) {
      if (!action.keywords.some((k) => k.startsWith(head) && head.length >= 2)) continue;
      const needsQuery = action.url.includes('{q}');
      if (needsQuery && !tail) continue;
      if (!needsQuery && tail) continue;
      hits.push({
        integration,
        action,
        url: action.url.replace('{q}', encodeURIComponent(tail)),
        label: action.label[lang].replace('{q}', tail),
      });
    }
  }
  return hits;
}
