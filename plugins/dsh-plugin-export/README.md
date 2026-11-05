# @local/dsh-plugin-export

Adds **导出插件 / Export plugin** to every installed bundle's Plugins detail page
(sidebar → Plugins → a bundle). One click:

1. downloads a shareable `@local/my-plugin-1.0.0.tgz` (standard npm tarball), and
2. copies an install blurb to the clipboard, so sharing never needs a second
   explanation of what the file is or how to install it.

## What the recipient does

Open DSH → **Plugins** → **Add plugin** and paste the `.tgz` file's absolute path
(for example `~/Downloads/my-plugin-1.0.0.tgz`). The Plugin Manager recognizes an
absolute `.tgz` path as a tarball spec, installs it with pnpm, and enables it.
Unzipping first and pasting the `package/` directory path works too.

## Archive shape

An npm-pack-style tarball: every package file under `package/`, plus a generated
`package/EXPORT-NOTE.md` written in Chinese, carrying the package name,
description and install steps. `node_modules`, `.git` and OS cruft are excluded;
dependencies come from the package's own `package.json` on install. Limits:
64 MiB / 4000 entries per bundle.

## How it works

- **Host** (`index.js`, `tar.js`): registers the authenticated route
  `GET|HEAD /api/plugin.export?name=<package>` through `ctx.connection.fetch`.
  The package directory is resolved through the Loader's own resolution bases
  (the same rule the client-module registry uses), so linked, npm, git and
  built-in rows all resolve. Archives are built with Node built-ins only — no
  dependency is added to the profile.
- **Client** (`client.js`): registers one button into the
  `plugins.detail.actions` slot, rendered with the detail page's subject; it
  renders only for `kind: 'bundle'` subjects that are installed. It issues a
  `HEAD` first so a failure (missing package, limits) shows as text instead of a
  silent download, then hands the `GET` route to the browser download manager
  and copies the blurb.

## Tests

```sh
node test/tar.test.mjs     # archive shape, exclusions, limits
node test/route.test.mjs   # resolution + route handler, real .tgz round-trip
```
