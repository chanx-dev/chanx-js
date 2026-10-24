---
'@chanx-js/codegen': patch
---

`channels.ts` imports `defineTopic` only when a channel has topics, so it compiles under `noUnusedLocals`, as in Vite's templates.
