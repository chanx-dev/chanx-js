---
'@chanx-js/server': patch
---

Handlers start in the order frames arrive, as in chanx: a frame without a payload no longer overtakes the one before it. Synchronous schemas are no longer awaited.
