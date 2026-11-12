# Arcadia for Dia

The Arc features Dia does not have, as an extension: spaces inside a profile,
mini windows, cleaned link copying and Clear. Named for the two browsers that
inspired it.

This is the `dia` branch. `main` is the Chrome version and `firefox` the
Firefox version. Dia already has a sidebar, a command bar on ⌘T and profiles
with separate logins, so this build draws no sidebar, leaves ⌘T alone and does
not try to separate logins.

> **Status: not yet run in Dia.** Dia is a Mac app and could not be run where
> this was written. The build was exercised in Chromium, which Dia is based on,
> with both ways of keeping spaces. What Dia itself does with tab groups, popup
> windows and shortcuts from an extension is unverified.

## Install

1. Unzip the folder somewhere permanent.
2. In Dia, open the extensions page (`chrome://extensions` works in
   Chromium-based browsers) and turn on **Developer mode**.
3. Click **Load unpacked** and choose this folder.
4. Pin Arcadia to the toolbar.

Repeat in each Dia profile where you want spaces.

## What it adds

| | |
|---|---|
| **Spaces inside a profile** | Several sets of tabs that share one profile's logins: Work and Reading, say, both signed in as you. Switch from the spaces menu (toolbar icon, keys 1 to 9), with shortcuts, or from the palette. |
| **New tabs stay in their space** | A tab you open joins the space you are in. |
| **Move a tab to another space** | From the palette: "Move tab to space …". |
| **Mini window** | A small window with one page and no sidebar (Arc's Little Arc). Shift-click a link, right-click › *Open link in mini window*, or press the shortcut. ⌘O inside it moves the page to your main window. |
| **Cleaned links** | Copying the page link leaves out tracking parameters such as `utm_source` and `fbclid`. |
| **Clear** | Closes the current space's tabs you are not using. The tab in front, pinned tabs and tabs playing sound stay. |
| **Palette** | ⌥⇧K opens Arcadia's own small command palette for the above, without touching Dia's ⌘T. |

For separate logins, use Dia's own profiles. An extension cannot separate
logins in a Chromium-based browser.

## Two ways of keeping spaces

Arcadia picks one automatically; you can force either in settings.

- **Tab groups** (tried first). Everything stays in one window. Each space is a
  group in Dia's sidebar: the one you are in is open, the others are folded.
  Opening a folded group switches to that space.
- **Separate windows** (the fallback). Each space is its own Dia window, and
  switching brings that window forward. Moving a tab between spaces moves it
  between windows without reloading. Closing a space's window keeps the space;
  going to it again opens a new window.

The fallback exists because Dia has, at least in the past, not let extensions
manage tab groups. If Dia refuses, the spaces menu says so and Arcadia switches
to windows by itself.

Pinned tabs are Dia's own and are never touched: they belong to the profile,
not to a space.

## Shortcuts

| Action | Default |
|---|---|
| Spaces menu | ⌥⇧S |
| Arcadia palette | ⌥⇧K |
| New mini window | ⌥⇧M |
| Copy cleaned link | ⇧⌘C on web pages, if the page receives the key |
| Move mini window page to main window | ⌘O, inside a mini window |
| Next/previous space, clear unused tabs, pop tab out, copy as Markdown | none; assign them on the browser's extension shortcuts page |

The browser decides which defaults it accepts. The settings page shows what is
actually assigned. If Dia handles ⇧⌘C itself, give "Copy the current page
link" a different shortcut to get the cleaned version.

## Privacy

- **No network.** Arcadia never makes a request. Its pages run under a
  content-security policy with `connect-src 'none'`.
- **No record of browsing.** No visited pages, clicks or events are logged or
  stored.
- **What is stored**, in this profile only (`chrome.storage.local`): your
  spaces, your settings, which space was last open, and the order of the
  spaces' windows (so they can be matched again after a restart).
- **In memory only** until the browser quits: tab, group and window ids. No
  addresses.
- **History and bookmarks** are read locally while you type in the palette.
  Turn that off in settings.

## Files

```
manifest.json
background.js        spaces (groups or windows), mini windows, link copying, palette results
popup/               the spaces menu
bar/                 the palette (overlay, full tab, mini window)
lib/                 colours, icons, helpers, the shared space form
content/content.js   copy-link key, shift-click, overlay host, toasts
offscreen/           clipboard helper
options/             settings and setup
```
