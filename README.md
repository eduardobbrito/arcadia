# Arcadia for Firefox

An Arc-style sidebar for Firefox: spaces with their own logins, pinned tabs, a
swipe between spaces, a command bar on new tab, mini windows and one-key link
copying. Named for the two browsers that inspired it.

This is the `firefox` branch. The `main` branch is the Chrome version. Firefox
allows the two things Chrome does not:

- **Each space is a Firefox container**, so each space has its own cookies and
  logins.
- **Firefox's own tab strip can be hidden**, so Arcadia's sidebar is the only
  tab list.

> **Status: not yet run in Firefox.** This port was written and checked
> against Firefox's published extension API definitions, and its logic was
> exercised in a test rig that imitates those APIs, but it has not been loaded
> in a real Firefox. Expect to find rough edges on first use.

## Install

Firefox only installs unsigned extensions temporarily.

**To try it** (lasts until Firefox restarts):

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and choose `manifest.json` in this folder.
3. If the command bar or the copy-link key does nothing on web pages, open
   `about:addons`, choose Arcadia › Permissions, and turn on *Access your data
   for all websites*.

Every restart removes a temporary add-on, and any Arcadia page left open then
shows up blank. Load it again with steps 1 and 2. Installing `userChrome.css`
(below) needs a restart, so expect to do this once right after.

**To keep it** across restarts, package it and install the package. The package
is a zip with `manifest.json` at its top level:

```bash
git archive --format=zip -o ../arcadia-firefox.xpi firefox
```

Then either:

- **Have Mozilla sign it** (free, and it stays unlisted). Sign in at
  addons.mozilla.org/developers, choose *Submit a New Add-on* › *On your own*,
  and upload the package. Download the signed `.xpi` it gives back, then in
  `about:addons` click the gear › *Install Add-on From File…*. This works in
  ordinary Firefox.
- **Or skip signing** in Firefox Developer Edition, Nightly or ESR: set
  `xpinstall.signatures.required` to `false` in `about:config`, then install
  the package from `about:addons` the same way. Ordinary Firefox ignores that
  setting.

Requires Firefox 128 or later.

## Hide Firefox's tab strip

No extension may hide the tab strip, so this takes a small file in your
Firefox profile. It is in this folder as `firefox/userChrome.css`.

1. Open `about:config` and set
   `toolkit.legacyUserProfileCustomizations.stylesheets` to `true`.
2. Open `about:support`, find **Profile Folder** and open it. Create a folder
   named `chrome` inside it and copy `firefox/userChrome.css` there.
3. Restart Firefox.

With Firefox's title bar switched on (*Customize Toolbar › Title Bar*) the
strip disappears completely. Without it, the strip stays as a slim empty bar,
because it also carries the window's close, minimise and zoom buttons.

Until you do this, Arcadia still keeps the strip tidy: it only ever shows the
current space's tabs.

## What it does

| | |
|---|---|
| **Sidebar** | In Firefox's sidebar, washed in the current space's colour: tiles for tabs pinned in every space, the space's own pinned tabs, then its open tabs. Drag to reorder, pin or unpin; right-click for more. |
| **Spaces with their own logins** | Every space after the first is a Firefox container. Sign in to one account in Work and another in Personal. Your first space keeps the logins Firefox already has. |
| **Only the current space is visible** | Tabs from other spaces are hidden from Firefox's tab strip and from Ctrl+Tab. |
| **Switching** | A two-finger swipe across the sidebar, the icons at the bottom, a shortcut, or the command bar. Choosing a tab in another space takes you there. |
| **New tabs land in the current space** | Tabs opened from the command bar start in the space's container. A tab opened some other way (a bookmark, a link from another app) is reopened in it. |
| **Pinned tabs** | Drag a tab above the line to pin it to the space. Closing a pinned tab only puts it to sleep; it stays in the list and wakes on click. |
| **Pinned in every space** | Drag a tab to the tiles at the top. It is a Firefox pinned tab, never hidden, and keeps the container it was opened in. |
| **Command bar on ⌘T** | A floating bar over the page: type an address, a search, the name of an open tab, a pinned tab, or a command. ⌘↩ opens in a background tab. It also does sums. |
| **⇧⌘C copies the link** | With tracking parameters removed, and a small confirmation. |
| **Mini window** | A small window with one page and no tab strip, in the current space's container. Shift-click a link, right-click › *Open link in mini window*, or press the shortcut. ⌘O inside it moves the page to your main window. |
| **Clear** | Closes the open tabs you are not using. The tab in front and tabs playing sound stay. |
| **Recently closed** | The clock at the bottom lists Firefox's own recently-closed tabs. |

## Shortcuts

| Action | Default | Notes |
|---|---|---|
| Command bar | ⌘T | Works out of the box (see below) |
| Copy link | ⇧⌘C | Works on web pages out of the box |
| Show or hide the sidebar | ⌥⇧S | |
| Command bar, without opening a tab | ⌥⇧K | |
| New mini window | ⌥⇧M | |
| Move mini window page to main window | ⌘O | Inside a mini window |
| Next/previous space, pin tab, edit current address, pop tab out, copy as Markdown | none | Assign in the Add-ons Manager: gear › Manage Extension Shortcuts |

## How spaces and containers fit together

- **A tab belongs to the space that was open when it appeared.** Firefox
  remembers this with the tab, so it survives a restart.
- **A tab's container cannot be changed.** Moving a web page to another space
  therefore reopens it in that space's container: it reloads, signed in as
  that space.
- **Firefox's own pages** (`about:` pages, Arcadia's settings) cannot live in a
  container. They still belong to the space where you opened them.
- **A space reuses a container with the same name** if Firefox already has one
  that no other space is using. So a space called Work picks up an existing
  Work container and its logins.
- **Deleting a space** moves its open tabs to the neighbouring space and leaves
  the Firefox container, with its logins, alone. Remove the container in
  Firefox's settings if you want it gone.
- **Removing a container in Firefox's settings** closes its tabs and signs it
  out. The space stays and gets a fresh container the next time it opens a
  page.
- Firefox may ask whether Arcadia may keep tabs hidden. Choose **Keep Tabs
  Hidden**.

## What Firefox will not allow

**⌘T belongs to Firefox.** Arcadia notices Firefox's new tab the moment it
appears, closes it, and shows the command bar over the page you were on. On
pages Firefox protects (`about:` pages, addons.mozilla.org) the bar opens as a
full tab instead. Turn this off in settings to get Firefox's new tab back.

**Site icons.** Firefox gives extensions no local icon store, and Arcadia's
pages never use the network. Instead the page hands over the icon it has
already loaded, read from the browser's cache. An icon served from a different
host than the page cannot be read that way; those sites show their initial.

**Links from other apps** can open in a mini window (off by default). Firefox
does not say where a tab came from, so this is a guess based on window focus.

## Privacy

- **No network.** Arcadia never makes a request. Its pages run under a
  content-security policy with `connect-src 'none'` and images limited to the
  extension itself, so they cannot reach anything outside. The site-icon read
  described above uses the cache only (`only-if-cached`) and cannot go to the
  network.
- **No record of browsing.** No visited pages, clicks or events are logged or
  stored.
- **What is stored**, in this Firefox profile only (`storage.local`): your
  spaces, the tabs you pin (title, address and site icon at the moment you
  pinned them), your settings, and which space was last open.
- **Stored with each tab by Firefox:** the id of the space it belongs to.
- **In memory only** until Firefox quits: which tab belongs to which pinned
  entry, and the icons of open tabs. No addresses or site names.
- **History and bookmarks** are read locally while you type in the command bar.
  Turn that off in settings.
- The page script reacts to the copy-link key and shift-clicks on links, and
  reads the page's own icon. It reads nothing else from pages.

## Files

```
manifest.json
background.js         state, spaces and containers, pinned tabs, command bar results, mini windows
sidepanel/            the sidebar
bar/                  the command bar (overlay, full tab, mini window, inside the sidebar)
lib/                  colours, icons, helpers, the shared space form
content/content.js    copy-link key, shift-click, overlay host, toasts, site icon
options/              settings and setup
firefox/userChrome.css  hides Firefox's own tab strip (you install this by hand)
```
