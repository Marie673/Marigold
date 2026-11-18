# Marigold for iOS

Companion app for the Marigold desktop browser: the same profiles and tabs on
your phone, end-to-end encrypted through your self-hosted sync server
(`docs/sync-protocol.md`), plus an AI panel that relays through your computer.

> **Status: not compiled yet.** This code was written without an Xcode
> toolchain. Expect to fix a few compiler errors on the first build.

## Build

    brew install xcodegen
    cd ios && xcodegen && open Marigold.xcodeproj

Requires Xcode 15+ (iOS 17 SDK). Pick your team under *Signing & Capabilities*
to run on a device. `⌘U` runs `MarigoldTests`, which checks the crypto against
the test vector in the protocol doc.

## Pair

1. On the desktop, open Marigold's sync settings to show the pairing QR code / link.
2. Scan the QR code with the iPhone Camera (it opens `marigold://sync?...` in
   the app), or paste the link under **Settings → Sync → Pair**.

The credentials are kept in the Keychain. Without pairing the app still works,
with tabs stored on the device only. A sync server on your LAN may use plain
`http://` (App Transport Security allows local networking).

## What works

- **Sync**: pull (`since`/`more`), debounced push, live updates over SSE with
  reconnect/backoff, 30 s fallback poll, last-writer-wins merge.
- **Profiles**: switch between synced profiles; each has its own cookie store.
- **Tabs**: pinned grid, open list, archive with restore, new / close / pin,
  swipe actions. Tabs are shared with the desktop.
- **Auto-archive**: idle unpinned tabs move to the archive (interval in Settings).
- **AI panel**: chat through a desktop signed in to Claude Code or Codex CLI,
  optionally with the current page as context; streaming and stop.
- English and Japanese UI.

## Layout

    Marigold/Sync      protocol + crypto, record store, sync engine, keychain
    Marigold/Browser   app model (profiles, tabs, auto-archive), WKWebView pool
    Marigold/Views     tab switcher, archive, browser, settings
    Marigold/AI        relay chat model + panel
    MarigoldTests      protocol test vector, JSON shapes, LWW, pairing link

## Not done yet

App icon, creating/editing profiles, tab reordering, downloads, and
JavaScript alert/confirm panels.
