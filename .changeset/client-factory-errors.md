---
'@chanx-js/client': patch
---

An error thrown while opening a socket, such as no global `WebSocket`, is reported through `reportError` instead of being retried in silence.
