import { app, type MenuItemConstructorOptions } from 'electron';

const JA: Record<string, string> = {
  File: 'ファイル', Edit: '編集', View: '表示', Tabs: 'タブ',
  'New Tab': '新しいタブ', 'Close Tab': 'タブを閉じる', 'Reopen Closed Tab': '閉じたタブを復元', 'Settings…': '設定…',
  'Find in Page…': 'ページ内を検索…', 'Open Location…': 'URLを編集…', 'Toggle Assistant': 'アシスタントを開閉', 'Archived Tabs': 'アーカイブされたタブ',
  Reload: '再読み込み', 'Force Reload': 'キャッシュを無視して再読み込み', Back: '戻る', Forward: '進む',
  'Zoom In': '拡大', 'Zoom Out': '縮小', 'Actual Size': '実際のサイズ', 'Developer Tools': 'デベロッパーツール',
  'Pin / Unpin Tab': 'ピン留め / 解除', 'Next Tab': '次のタブ', 'Previous Tab': '前のタブ',
  'Pin Tab': 'ピン留め', 'Unpin Tab': 'ピン留めを外す', Duplicate: '複製', 'Close Other Tabs': '他のタブを閉じる', 'Unload from Memory': 'メモリから解放',
  'Open Link in New Tab': 'リンクを新しいタブで開く', 'Copy Link': 'リンクをコピー', 'Open Image in New Tab': '画像を新しいタブで開く', 'Copy Image': '画像をコピー',
  'Inspect Element': '要素を検証', Allow: '許可', Block: 'ブロック', Open: '開く', Cancel: 'キャンセル', Delete: '削除',
};

export const isJa = () => app.getLocale().toLowerCase().startsWith('ja');

/** Translates a UI label; English is the source language. */
export const L = (en: string) => (isJa() ? (JA[en] ?? en) : en);

export function localize(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.map((i) => ({
    ...i,
    ...(i.label ? { label: L(i.label) } : {}),
    ...(Array.isArray(i.submenu) ? { submenu: localize(i.submenu) } : {}),
  }));
}
