# Arcadia

An Arc-style sidebar for Google Chrome: spaces, pinned tabs, a swipe between
spaces, a command bar on new tab, mini windows and one-key link copying. Named
for the two browsers that inspired it.

Arcadia is a plain Manifest V3 extension: no build step, no dependencies, no
network access.

## Install or update

1. Unzip the folder somewhere permanent (Chrome loads it from that location).
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `arcadia` folder.
   To update, replace the folder's contents and click the reload arrow on the
   Arcadia card. Your spaces and pinned tabs are kept.
4. Click the Arcadia icon in the toolbar to open the sidebar, and set *Side
   panel position* to **left** in `chrome://settings/appearance`.
5. **Turn off Chrome's vertical tabs** so there is one sidebar: right-click
   Chrome's tab strip and choose **Show Tabs Horizontally**.

Repeat in each Chrome profile where you want it.

### Why step 5 is needed

Chrome does not let an extension draw inside its vertical tab strip, restyle
it, or hide it. The only sidebar an extension can render is Chrome's side
panel, so that is where Arcadia's sidebar lives. With Chrome's vertical tabs
also on you would see two sidebars.

Chrome's horizontal tab strip stays along the top; it cannot be removed either.
In full screen it hides if you turn off *View › Always Show Toolbar in Full
Screen*; then switch on *Back, forward and address in the sidebar* in Arcadia's
settings.

## What it does

| | |
|---|---|
| **Sidebar** | In Chrome's side panel, washed in the current space's colour: tiles for tabs pinned in every space, the space's own pinned tabs, then its open tabs. Drag to reorder, pin or unpin; right-click for more. |
| **Spaces** | Each space has its own pinned tabs, open tabs, colour and icon. Switch with a two-finger swipe across the sidebar, the icons at the bottom, a shortcut, or the command bar. |
| **New tabs land in the current space** | Any tab you open joins the space you are in. |
| **Pinned tabs** | Drag a tab above the line to pin it to the space. Closing a pinned tab only puts it to sleep; it stays in the list and wakes on click. If it wanders off, hover for **Back**. |
| **Pinned in every space** | Drag a tab to the tiles at the top, or right-click › *Keep pinned in every space*. |
| **Command bar on ⌘T** | A floating bar over the page: type an address, a search, the name of an open tab, a pinned tab, or a command. ⌘↩ opens in a background tab. It also does sums. |
| **⇧⌘C copies the link** | With tracking parameters removed, and a small confirmation. |
| **Mini window** | A small window with one page and no tab strip. Shift-click a link, right-click › *Open link in mini window*, or press the shortcut. ⌘O inside it moves the page to your main window. |
| **Clear** | Closes the open tabs you are not using. The tab in front and tabs playing sound stay. |
| **Recently closed** | The clock at the bottom lists Chrome's own recently-closed tabs. |

## Shortcuts

| Action | Default | Notes |
|---|---|---|
| Command bar | ⌘T | Works out of the box (see below) |
| Copy link | ⇧⌘C | Works on web pages out of the box |
| Show or hide the sidebar | ⌥⇧S | |
| Command bar, without opening a tab | ⌥⇧K | |
| New mini window | ⌥⇧M | |
| Move mini window page to main window | ⌘O | Inside a mini window |
| Next/previous space, pin tab, edit current address, pop tab out, copy as Markdown | none | Assign at `chrome://extensions/shortcuts` |

Chrome decides which defaults it accepts. The settings page shows what is
actually assigned.

## How it works, and what Chrome will not allow

**Spaces are Chrome tab groups.** One group per space per window, and switching
folds the others away, so Chrome's own tab strip stays in step with the
sidebar. With a single space, no groups are created.

**Pinned tabs are Chrome pinned tabs that move with the space.** When you leave
a space, its pinned tabs are unpinned and tucked into its folded group; when
you return they are pinned again. Nothing reloads.

**Spaces share logins.** Chrome has no way for an extension to separate cookies
inside one profile. For separate logins, use separate Chrome profiles and load
Arcadia in each. Switching Chrome profiles from within Arcadia is not possible
from an extension alone; it needs a small helper app on the Mac.

**⌘T belongs to Chrome.** An extension cannot take the key. Arcadia instead
notices Chrome's new tab the moment it appears, closes it, and shows the
command bar over the page you were on. On pages Chrome protects (`chrome://`
pages, the Web Store) the bar opens as a full tab instead. Turn this off in
settings to get Chrome's normal new tab back.

**The side panel has a minimum width** set by Chrome, wider than Arc's sidebar,
and Chrome adds a small title row above it.

**Links from other apps** can open in a mini window (off by default). Chrome
does not say where a tab came from, so this is a guess based on window focus.

**Prefer Chrome's vertical tabs?** In settings, set *Sidebar* to *Chrome's
vertical tabs*. Spaces then show as groups in Chrome's strip, pinned tabs as
its tiles, and the toolbar icon opens a spaces menu. Chrome's strip cannot
show Arcadia's design or take the swipe gesture.

## Privacy

- **No network.** Arcadia never makes a request. Its pages run under a
  content-security policy with `connect-src 'none'` and images limited to the
  extension itself, so they cannot reach anything outside.
- **No record of browsing.** No visited pages, clicks or events are logged or
  stored.
- **What is stored**, in this Chrome profile only (`chrome.storage.local`):
  your spaces, the tabs you pin (title and address at the moment you pinned
  them), your settings, and which space was last open. That is all.
- **In memory only** until Chrome quits: which tab belongs to which pinned
  entry, by numeric id. No addresses.
- **History and bookmarks** are read locally while you type in the command bar.
  Turn that off in settings.
- The page script reacts to two things: the copy-link key and shift-clicks on
  links. It reads nothing else from pages.

## Files

```
manifest.json
background.js        state, spaces, tab groups, pinned tabs, command bar results, mini windows
sidepanel/           the sidebar
bar/                 the command bar (overlay, full tab, mini window, inside the sidebar)
lib/                 colours, icons, helpers, the shared space form
content/content.js   copy-link key, shift-click, overlay host, toasts
offscreen/           clipboard helper
options/             settings and setup
popup/               the spaces menu, used with Chrome's vertical tabs
```
