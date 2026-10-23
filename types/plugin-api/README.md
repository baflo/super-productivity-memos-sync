# Vendored plugin API types

`index.ts`, `types.ts` and `issue-provider-types.ts` are copied unchanged from
[Super Productivity](https://github.com/super-productivity/super-productivity)
`packages/plugin-api/src` at commit `b3ccc4c` (version 19.2.0). They are MIT
licensed, see `LICENSE` in this folder.

The npm package `@super-productivity/plugin-api` (1.0.1) is older and lacks the
issue provider types, `registerTaskContextMenuEntry` and the secret storage
API, so the plugin type-checks against these files instead. `tsconfig.json`
maps the package name here; the plugin only uses `import type`, so nothing
from this folder ends up in the bundle.

To update: copy the three files from a newer Super Productivity checkout and
note the commit above.
