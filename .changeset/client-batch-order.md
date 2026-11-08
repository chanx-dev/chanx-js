---
'@chanx-js/client': patch
---

Unbatched `on` handlers no longer overtake waiting batches: those are delivered first, in arrival order.
