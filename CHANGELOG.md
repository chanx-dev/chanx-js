# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [2.0.0](https://github.com/huynguyengl99/chanx-js/compare/v0.1.3...v2.0.0) (2026-10-24)

## [0.1.3](https://github.com/huynguyengl99/chanx-js/compare/v0.1.2...v0.1.3) (2026-10-24)

### Features

- **layers:** add channel layers with a Redis pub/sub layer compatible with Python's ([d708320](https://github.com/huynguyengl99/chanx-js/commit/d708320f7f190c8677fdead32a693eeadd177b82))
- **nestjs:** add the NestJS integration ([0752b07](https://github.com/huynguyengl99/chanx-js/commit/0752b07365a709d32def877c08cc9ccd4b008434))
- **server:** add a Fastify adapter ([d383df9](https://github.com/huynguyengl99/chanx-js/commit/d383df9bc0cd730a365e7afa3dcdefeb64ac3158))
- **server:** add class consumers with decorators ([cbf1f1e](https://github.com/huynguyengl99/chanx-js/commit/cbf1f1ec979dcb74eaf4cc4ebc8f42059a656ff2))
- **server:** add crossws and Hono adapters ([fe9bfa1](https://github.com/huynguyengl99/chanx-js/commit/fe9bfa109675307c5db389885e6d9f8e818ea44a))
- **server:** add error hooks to consumers and topics ([293f1ed](https://github.com/huynguyengl99/chanx-js/commit/293f1edc92bfb976cd876621f62e2e70e7c6acf1))
- **server:** add groups, broadcasts and events over channel layers ([aad2a9f](https://github.com/huynguyengl99/chanx-js/commit/aad2a9f13321312f448f1e22a2b8d8596c691f8e))
- **server:** add messages, consumers and frame dispatch ([531955e](https://github.com/huynguyengl99/chanx-js/commit/531955e5641db4df24108d2ee7e165c633b83c86))
- **server:** add rejectBeforeUpgrade to refuse upgrades with an HTTP status ([55e20d1](https://github.com/huynguyengl99/chanx-js/commit/55e20d1613f081db1d52a8e6604445bd52f553fe))
- **server:** add Topic classes and per-subscription state ([d588f3c](https://github.com/huynguyengl99/chanx-js/commit/d588f3c60cb5c7121382cebd3796dc1293c78e42))
- **server:** add topics ([cb2379e](https://github.com/huynguyengl99/chanx-js/commit/cb2379e9481e5bc82a46d468d92d790cab60df0d))
- **server:** drop clients that stop reading in the ws adapters ([c362855](https://github.com/huynguyengl99/chanx-js/commit/c3628557dfd7642997209a51a2c18a09b1c1e947))
- **server:** generate AsyncAPI as chanx does ([a632134](https://github.com/huynguyengl99/chanx-js/commit/a6321343329e6c76b70f2386490c9615b90e65e2))
- **server:** serve consumers on Node HTTP servers through ws ([01dba51](https://github.com/huynguyengl99/chanx-js/commit/01dba5174f0823744ae38fb1087567c8341310a6))
- **server:** stricter public types, test captures and chanx 2.11.8 frames ([f1dcb86](https://github.com/huynguyengl99/chanx-js/commit/f1dcb867f310d4f70f2625517368c0582b833378))

### Bug Fixes

- **server:** validate a consumer with one handler as chanx does ([c1428c5](https://github.com/huynguyengl99/chanx-js/commit/c1428c57f6f749e36978b1e11ce1272c7eded61e))

## [0.1.2](https://github.com/huynguyengl99/chanx-js/compare/v0.1.1...v0.1.2) (2026-09-26)

### Bug Fixes

- **codegen:** name a topic-only consumer's connection after the consumer ([5499bf7](https://github.com/huynguyengl99/chanx-js/commit/5499bf7073b00adbd70d410ba9438e3b58efc5a8))
- **codegen:** re-export reused types from schemas ([cf266fa](https://github.com/huynguyengl99/chanx-js/commit/cf266fa8114f008560f6bfbae08de6a7ac0b95b6))

## [0.1.1](https://github.com/huynguyengl99/chanx-js/compare/v0.1.0...v0.1.1) (2026-09-26)

### Features

- **core:** pass the frame envelope to handlers ([380b85a](https://github.com/huynguyengl99/chanx-js/commit/380b85ad0a35e9c36874f10289005e8be90c5ec8))

### Bug Fixes

- infer every joined topic in useTopics and createTopics ([ad9c076](https://github.com/huynguyengl99/chanx-js/commit/ad9c076f58ce6e484486b1bff180d58c41dfa306))

## 0.1.0 (2026-09-26)

### Features

- **codegen:** add @chanx-js/codegen ([b9d8333](https://github.com/huynguyengl99/chanx-js/commit/b9d8333ffd8e70d160b272a24e8b2c0136911540))
- **core:** add the framework-agnostic controller ([2398697](https://github.com/huynguyengl99/chanx-js/commit/2398697052aef819d7a48649b5b7197fd036985f))
- **core:** add the protocol, shared socket, connections and topics ([be847bd](https://github.com/huynguyengl99/chanx-js/commit/be847bd7881c278e6c4b936cb9e16e7c70c1e62a))
- **react:** add useChannel, useTopic and useTopics ([c717523](https://github.com/huynguyengl99/chanx-js/commit/c71752321363f84a3675c352f3494dc6cafb7a80))
- **vue,svelte,solid:** add the Vue, Svelte and Solid bindings ([a86c6ec](https://github.com/huynguyengl99/chanx-js/commit/a86c6ece1f47cc1df8e4a72e8cf693f75d0ba373))
