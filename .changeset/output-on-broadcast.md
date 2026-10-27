---
'@chanx-js/server': patch
'@chanx-js/nestjs': patch
---

A handler's `output` now also declares what it broadcasts, as chanx's `output_type` does: a handler with `output` may return nothing. `emits` is for messages sent outside any handler.
