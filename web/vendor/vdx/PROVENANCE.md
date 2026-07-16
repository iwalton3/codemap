# Vendored: vdx-web framework

`framework.js` is the self-contained built bundle from /working/vdx-web/dist/framework.js
(zero external imports). Update by re-copying that file. Source: https://github.com/iwalton/vdx-web

`router.js` — from /working/vdx-web/dist/router.js (interoperates with framework.js via the global customElements registry).
`../marked.min.js` — marked v12.0.2 (MIT), from cl-pprint/static/vendor/marked.min.js. Markdown renderer.

_2026-07-15 re-vendor: framework.js + router.js updated with fixes for dynamic-SVG namespace and router :param* binding (see BUG-REPORT-from-codemap.RESPONSE.md)._
