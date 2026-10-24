---
'@chanx-js/client': minor
---

`request()` resolves with the reply its action declares, such as `PongMessage` for `ping`, on connections, topic handles and every framework binding. Descriptors take the replies as an optional third type argument; without it, replies stay `ChanxMessage`.
