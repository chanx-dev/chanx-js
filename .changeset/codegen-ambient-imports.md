---
'@chanx-js/codegen': patch
---

`--ambient` output compiles: channels no longer import reused globals from `schemas`, which stays a module when every type is reused.
