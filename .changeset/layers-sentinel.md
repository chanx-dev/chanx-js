---
'@chanx-js/layers': minor
---

`RedisPubSubChannelLayer` takes a Redis Sentinel host, `{ sentinels, masterName }` as in Python's `{"sentinels": [...], "master_name": ...}`, and follows the master through a failover.
