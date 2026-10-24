---
'@chanx-js/client': patch
---

`connection.ready()` rejects once the socket gives up, is refused or is terminated, instead of waiting forever.
