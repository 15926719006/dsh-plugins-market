# @local/dsh-pinned-top

Pinned Sessions get their own **置顶 / Pinned** section at the very top of the
sidebar, above every workspace group: the Host pin set, most recently pinned first.

A pinned row leaves its workspace group, so it is visible without expanding or
scrolling that group; unpinning puts the row back where the workspace order says.
Running state does not move rows on its own — only a pin does.

Hovering a workspace row also reveals **归档全部会话（保留置顶） / Archive all sessions
(pinned kept)**, which archives every ordinary Session under that workspace in one
click while leaving its pinned Sessions pinned.

## What it is

A fork of the shipped `@deepseek-ai/dsh-client-ui-workspace` browser bundle, so it
owns the whole `sidebar.workspaces` region exactly as the shipped plugin does
(same search, view options, drag, dialogs, row menu and row actions). Because it
replaces that bundle, it also **provides the `uiWorkspace` client service** — the
one the conversation input/composer, chat rows, sidebar decorations, agent-preset
menus and directory pickers inject. Any code replacement of this plugin therefore
touches every one of those consumers; see "Updating while the app is running".
The patch is a small, deterministic edit of that bundle:

- `deriveGroups` builds one synthetic leading group keyed `__pinned__` holding the
  Host pin set in pin order and filters those rows out of their workspace group;
- the section never applies the per-group row watermark, so every pinned row stays
  visible;
- its header shows the pin glyph, cannot be dragged, and carries no workspace
  actions (rename / delete / new session);
- pinned rows are not reorderable by drag: their order follows the Host pin order;
- a new locale key `group.pinned` supplies 置顶 / Pinned;
- each workspace row gains a hover archive button between its "..." menu and its
  new-Session button, rendered only while the workspace has archiveable Sessions.
  It archives every ordinary, unarchived, **unpinned** Session in that workspace
  through the shared archive action; archived rows, the New Session draft, subagent
  children and pinned rows are left alone, and a running Session is counted and
  reported as skipped rather than stopped. The result appears in the sidebar's
  Workspace notice.

### Why pinned Sessions are excluded from the bulk archive

Pinning and archival are mutually exclusive on the Host: `archiveSession` drops the
Session from the pin set in the same durable write, and an archived Session cannot
be re-pinned. A pinned row also no longer renders inside its workspace group (this
fork lifts it to the top section), so a bulk click on that group would archive and
unpin a row the user cannot even see there. The bulk target rule therefore filters
the pin set, and the row's hover button counts its targets through the same rule, so
a workspace whose only remaining Sessions are pinned shows no button at all. Archiving
a pinned row is still possible one row at a time from its own menu — an explicit
choice about that row. A Session pinned while the click is running is re-checked
before each Host call and left alone.

Everything else is the upstream bundle, verbatim.

## Tests

```sh
node test/groups.test.mjs
```

Covers the synthetic section against the compiled fork: pin ordering, collapsed
workspaces and collapsed section, archive filtering, missing ids, rows returned to
their groups, and that running state alone never lifts a row. It also pins the
one-click archive membership rule: archived rows, blank drafts, subagent children,
pinned rows and members without a loaded summary are excluded; the hover button's
count is derived from that same rule, so a workspace with nothing but pinned rows
shows no button.

## Install

Installed as a profile bundle; its patch disables the shipped `ui-workspace` row
and inserts this fork, so the two never register the same slots twice.

## Rebuild after a DeepSeek Harness update

The fork embeds a copy of the shipped Client bundle, which changes with the app.
After updating the desktop app, regenerate it against the new installation:

```sh
node build/fork.mjs
```

The script reads `app.asar` directly and fails loudly if an upstream anchor moved,
instead of shipping a half-patched sidebar. If an anchor is reported missing, diff
the new shipped `lib/client.js` around that spot and update `build/fork.mjs`.

## Updating while the app is running

This plugin is not a leaf decoration: it replaces the shipped workspace browser and
is the provider of the `uiWorkspace` client service, which the conversation
input/composer (`ui-conversation`), chat rows (`ui-chat`), sidebar, schedule,
agent-preset and directory-picker plugins all declare in `inject`. Replacing its code
therefore tears those consumers down and re-creates them. That is the mechanism
behind "改一下侧栏，对话框/输入框就没了".

`lib/client.js` is served by the running Harness, and the client HMR watcher
stat-polls the artifact of every enabled graph row roughly every 500 ms. Rewriting it
while the row is **enabled** publishes a `rebuilt` frame, which the page applies as
an **in-place code swap**: the old fiber is drained and the new bundle mounted.
Current DSH releases re-cascade the dependents through Cordis' activation epochs
(`dsh-client-hmr`, "Cascade and self-reload"), so the injecting views come back with
the new plugin. A failed import or activation has **no rollback**, so a broken build
leaves the page broken.

### Publishing procedures

1. **Page closed (deterministic, preferred).** Rebuild with no page open, then open
   or reload the page. No swap is published, so no consumer is torn down. Sessions
   keep running on the Host while the page is closed.
2. **Page open, row enabled (ordinary HMR rebuild).** Write the artifact and let the
   watcher swap it. Dependents re-cascade and the composer remounts; React state
   inside the reloaded plugins is lost (Session, workspace and draft data are not).
   Verify the build and `test/groups.test.mjs` first, because a bad swap is not
   rolled back.

Never publish by disabling the row, rebuilding, then enabling it. The watcher does
not track a disabled row, so no `rebuilt` frame is published — but re-enabling is an
ordinary graph change, and DSH documents that replacing package code together with
its existing consumers is *outside* ordinary enable/disable synchronization
(`dsh-client-modules`, "Known limitations"). On 2026-11-04 that sequence left the
composer unmounted until the page was rebooted. Shipping the change as a new bundle
version is a graph change of the same kind: fine for installation, not a better way
to iterate on this fork.

### Recovering a page that lost its composer

1. **Reload the page (Cmd+R).** A fresh boot rebuilds the whole client plugin tree,
   including every `uiWorkspace` consumer. No app restart and no Session loss.
2. If the reloaded page still boots without the composer, do **not** restart the app
   yet: open Settings → Plugins → Plugin list (it shows page-local synchronization
   failures and retries them without changing Host enablement) and capture what it
   reports — a restart destroys the evidence.
3. Restart the app only when both fail.

`node build/fork.mjs` writes atomically (temp file + rename) so a poll never
publishes a half-written bundle, and it restates the rules above after every build.

## Uninstall / revert

Remove the bundle (Plugins page, or `plugin_manager` `remove_bundle`); the patch
layer disappears with it, the shipped `ui-workspace` row activates again, and the
sidebar returns to the shipped grouping.
