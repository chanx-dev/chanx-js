---
'@chanx-js/server': minor
'@chanx-js/client': minor
'@chanx-js/nestjs': minor
---

Error frames now carry chanx's standard error format, an RFC 9457 problem details object with a `type` URI, and for validation failures `errors` giving each failure's JSON Schema `keyword` and a JSON `pointer`. Set `errorFormat: 'pydantic'` in `createChanx` to keep the earlier payloads. The client exports `isProblem()`, `ErrorType` and the `Problem` type.
