---
'@chanx-js/server': patch
---

`.passthrough()` relays a published event as sent once it validates, instead of its parsed value, so a schema's transforms (such as base64 to bytes) no longer reach the client.
