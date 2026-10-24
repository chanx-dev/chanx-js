---
'@chanx-js/client': patch
---

`for await` loops over a connection or topic end once the socket gives up reconnecting, instead of waiting forever.
