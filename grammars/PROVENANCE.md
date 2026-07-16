# Vendored grammars

Prebuilt `.wasm` pulled from each grammar project's **own** GitHub releases
(no third-party bundler). These are inert data — no build toolchain is involved
in consuming them. Re-verify with `sha256sum *.wasm`.

| File | Source repo | Tag | sha256 |
| --- | --- | --- | --- |
| tree-sitter-c_sharp.wasm | tree-sitter/tree-sitter-c-sharp | v0.23.5 | 6f69e1cae44e1c32c1eccc170dc5a9778fb94ff716f71113fe1f8c4299aa2f40 |
| tree-sitter-python.wasm | tree-sitter/tree-sitter-python | v0.25.0 | 16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47 |
| tree-sitter-javascript.wasm | tree-sitter/tree-sitter-javascript | v0.25.0 | 5fb488d0cabb4775a594bab85682de5ad6ce83c0d6ac997a9f82dd084d571240 |
| tree-sitter-typescript.wasm | tree-sitter/tree-sitter-typescript | v0.23.2 | 778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d |
| tree-sitter-tsx.wasm | tree-sitter/tree-sitter-typescript | v0.23.2 | 79e5da75ea62855a0cd67177685f0164eac87d5f630b3cbe1e0a099751ad30f8 |

Runtime: `web-tree-sitter` (the tree-sitter runtime compiled to wasm). These
grammar versions load under web-tree-sitter 0.26.x.
