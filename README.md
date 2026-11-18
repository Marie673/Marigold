# Marigold 🌼

軽くて、タブが勝手に片付いて、**自分が契約しているLLM**で動くAIネイティブなブラウザ。
デスクトップ版（Electron / Chromium）と、タブ・ピン留め・プロファイルを共有できる iOS 版、
それをつなぐ自前の同期サーバーで構成されています。

## できること

| | |
|---|---|
| **タブ設計** | 左サイドバーにピン留め（アイコンのグリッド）と開いているタブ。ピン留めしていないタブは、最後に使ってから指定時間（12時間 / 24時間 / 7日 / 30日 / しない）で自動的にアーカイブへ移動。閉じたタブもアーカイブに残り、`⌘⇧T` や `⌘Y` で戻せます。 |
| **軽さ** | ページを保持するのは「起きている」タブだけ。裏のタブは一定時間でメモリから解放され（音声再生中は除く）、起動時に読み込むのは表示中の1枚だけ。 |
| **プロファイル** | プロファイルごとにタブ・ピン留め・履歴・Cookie（ログイン状態）が完全に分離。サイドバー下のドットで切り替え。 |
| **Ask anything** | 新しいタブ（`⌘T`）は入力欄ひとつ。URLなら開く、言葉なら検索、質問ならAIへ。`⇧↵` で常にAIに聞く。 |
| **AIペイン** | `⌘E` で右側に開く。表示中のページ（選択範囲も）を文脈に質問・要約。他のタブも追加して比較できます。 |
| **自分のサブスクで動くAI** | APIキー不要。このPCでログイン済みの公式CLIを使います：**Claude Pro/Max → Claude Code**、**ChatGPT Plus/Pro → Codex CLI**。 |
| **アプリ連携** | GitHub / Gmail / Notion / Google Calendar / Slack を認識。コマンド（`gh 検索語`、`mail`、`pr`、`notion` …）、Gmailの未読バッジ、ページに合った質問候補、AI向けの本文抽出。 |
| **同期** | 端末内で暗号化（AES-256-GCM）してから自前サーバーへ。サーバーは中身を読めません。 |
| **iOS版** | 同じタブ・ピン留め・プロファイルを共有。AIは**ペアリングしたデスクトップのサブスクを中継**して使います。 |

## 使い方（デスクトップ）

```bash
npm install
```

```bash
npm start
```

AIを使うには、どちらか（または両方）をインストールしてログインしておきます。

```bash
npm install -g @anthropic-ai/claude-code && claude
```

```bash
npm install -g @openai/codex && codex login
```

配布用パッケージ（dmg / exe / AppImage）は `npm run dist`。

## 同期サーバー

依存ゼロの Node スクリプトです（Node 22.18 以上）。

```bash
npm run sync-server
```

Docker なら `sync/server/Dockerfile`。環境変数: `PORT`（既定 8787）、`HOST`、`MARIGOLD_DATA_DIR`、`MARIGOLD_MAX_ACCOUNTS`。
インターネット越しに使う場合は HTTPS のリバースプロキシ（Caddy など）の後ろに置いてください。

1. デスクトップの 設定 → 同期 にサーバーのURLを入れて「この端末で同期を開始」
2. 表示されたQRコードを iPhone のカメラで読む（またはリンクを別の端末の Marigold に貼る）

ペアリングリンクは鍵そのものです。仕様は [docs/sync-protocol.md](docs/sync-protocol.md)。

## iOS版

[ios/README.md](ios/README.md) を参照（XcodeGen + Xcode 15 以上）。

## 開発

```
src/main      メインプロセス（タブ管理・AI・同期クライアント）
src/renderer  ブラウザのUI（Preact）
src/shared    共通ロジック（自動アーカイブ判定・アプリ連携の定義）
sync/core     同期プロトコルと暗号
sync/server   同期サーバー
ios           iOS アプリ（SwiftUI）
```

```bash
npm test
```

```bash
npm run typecheck
```

`npm run test:e2e` は実際のアプリを起動して一通り操作します（Linux + xvfb）。
`MARIGOLD_E2E_AI=1` を付けると、ログイン済みの Claude CLI でAIとiOS向け中継も検証します。

## 設計メモと制限

- **AIの安全性**: Webページは信頼できない入力として扱い、CLIはツール無効（Claude）/ 読み取り専用サンドボックス（Codex）・空の作業ディレクトリで起動します。AIはページを読むだけで、クリックや操作はしません。
- **アプリ連携**はブラウザ内のログインセッションを使う方式で、各サービスのOAuthアプリ連携ではありません。
- Chrome拡張機能、タブのフォルダ、パスワードマネージャーは未対応です。
- GoogleはElectron製ブラウザからのログインを拒否することがあります。
