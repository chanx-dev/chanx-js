---
'@chanx-js/server': minor
---

AsyncAPI documents list the error payload schemas, `ChanxProblem` and `ChanxProblemError`, as chanx does, so generated clients get typed errors. Envelope integers (`version`, `seq`) are read leniently as chanx reads them: `"12"`, `"1_000"`, `"12.0"` and `true` are accepted.
