# Vendored: vdx-web framework

`framework.js` is the self-contained built bundle from /working/vdx-web/dist/framework.js
(zero external imports). Update by re-copying that file. Source: https://github.com/iwalton/vdx-web

`router.js` — from /working/vdx-web/dist/router.js (interoperates with framework.js via the global customElements registry).
`../marked.min.js` — marked v12.0.2 (MIT), from cl-pprint/static/vendor/marked.min.js. Markdown renderer.

_2026-07-15 re-vendor: framework.js + router.js updated with fixes for dynamic-SVG namespace and router :param* binding (see BUG-REPORT-from-codemap.RESPONSE.md)._

## Type declarations

`framework.d.ts` / `router.d.ts` are copied from `/working/vdx-web/lib/` (the
same source tree the bundles are built from) and are what makes `checkJs` mean
anything for the app — see `web/tsconfig.json`.

They describe `lib/`, not the `dist/` bundle, so re-check the two after any
re-vendor. As of this copy nothing the `.d.ts` declares is missing from the
bundle (the failure that would matter: an import that compiles and is undefined
at runtime). Ten bundle exports are untyped — `contain`, `createRoot`,
`flushEffects`, `setEffectErrorHandler`, `clearTemplateCache` and the `isX`
guards — all optimizer-facing, none imported by this app.

Re-vendoring is also the moment to re-run the framework's own template lint,
which covers the string-form bindings TypeScript treats as opaque text:

```sh
cd /working/vdx-web/tools && node optimize.js -i <codemap>/web --templates-only
```
