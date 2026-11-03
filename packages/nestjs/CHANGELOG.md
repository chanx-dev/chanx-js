# @chanx-js/nestjs

## 2.1.0

### Minor Changes

- a59d0b1: Error frames now carry chanx's standard error format, an RFC 9457 problem details object with a `type` URI, and for validation failures `errors` giving each failure's JSON Schema `keyword` and a JSON `pointer`. Set `errorFormat: 'pydantic'` in `createChanx` to keep the earlier payloads. The client exports `isProblem()`, `ErrorType` and the `Problem` type.

### Patch Changes

- Updated dependencies [215258b]
- Updated dependencies [a59d0b1]
  - @chanx-js/server@2.2.0

## 2.0.4

### Patch Changes

- 63fdb6b: A handler's `output` now also declares what it broadcasts, as chanx's `output_type` does: a handler with `output` may return nothing. `emits` is for messages sent outside any handler.
- Updated dependencies [63fdb6b]
  - @chanx-js/server@2.1.4

## 2.0.3

### Patch Changes

- 91e6aa7: Point the repository, homepage and issue links at the chanx-dev org and the js.chanx.dev docs.
- Updated dependencies [91e6aa7]
  - @chanx-js/server@2.1.2

## 2.0.2

### Patch Changes

- e1abc6a: The package README says what the package is for, shows a working example, and links to the docs.
- Updated dependencies [e1abc6a]
  - @chanx-js/server@2.0.2

## 2.0.1

### Patch Changes

- c797122: Depend on any compatible 2.x of `@chanx-js/layers` and `@chanx-js/server`, not only the exact version released alongside.
- Updated dependencies [c797122]
  - @chanx-js/server@2.0.1
