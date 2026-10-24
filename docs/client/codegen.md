# Code generation

`@chanx-js/codegen` reads the AsyncAPI 3 document a chanx server publishes and writes typed channel descriptors for the runtime.

```bash
npx @chanx-js/codegen <url-or-path> -o src/generated
```

The schema can be a URL or a local file, in JSON or YAML.

## Options

| Option                | Default         | Effect                                                            |
| --------------------- | --------------- | ----------------------------------------------------------------- |
| `-o, --out <dir>`     | `src/generated` | Output directory                                                  |
| `--emit <target>`     | `ts`            | `ts` for TypeScript, `js` for JavaScript plus `.d.ts`             |
| `--validation <mode>` | `none`          | `zod` also emits zod schemas and wires them into the descriptors  |
| `--reuse-from <glob>` |                 | Reference existing types instead of generating them (repeatable)  |
| `--alias <mapping>`   |                 | Rewrite import paths, e.g. `src/=@/` (repeatable)                 |
| `--reuse-strict`      |                 | Emit compile-time checks that reused types still match the schema |
| `--ambient`           |                 | Treat reused types as global scripts: skip them, emit no imports  |
| `--no-format`         |                 | Skip prettier (it is used when installed)                         |

## What it generates

For each channel, a descriptor, the two message unions named from the client's side, and
what answers each request:

```ts
export type ChatToServer = ChatMessage | PingMessage;
export type ChatToClient = ChatNotificationMessage | PongMessage;
export type ChatReplies = {
  ping: PongMessage;
};

export const chat = defineChannel<
  ChatToServer,
  ChatToClient,
  ChatReplies
>()({
  name: 'chat',
  address: '/ws/chat/{room}/',
  heartbeat: true,
});
```

A channel carrying topics nests them under the connection they share:

```ts
export const topicHub = defineChannel<
  TopicHubToServer,
  TopicHubToClient
>()({
  name: 'topic_hub',
  address: '/ws/topics',
  topics: {
    roomTopic: defineTopic<
      TopicHubRoomTopicToServer,
      TopicHubRoomTopicToClient
    >()({
      name: 'room_topic',
      pattern: 'room:{room_name}',
    }),
  },
});
```

`ChatReplies` comes from each handler's `reply` in the schema: the `output` of a
chanx-js handler, or the return type of a chanx one. It types what
[`request()`](/client/connections#sending-and-requests) resolves with. A channel or
topic whose handlers reply to nothing gets no replies type.

When a consumer declares only topics, it has no plain channel. Its topics still get a connection named after the consumer, carrying no messages of its own: `agent.topics.threadTopic`. A topic served on its own route is emitted as a connection that carries itself as its only topic.

### The `action` discriminant

chanx gives every message's `action` a constant _and_ a default, so the schema leaves it out of `required`. A naive generator emits `action?: 'ping'`, which admits `undefined` into the union and silently disables exhaustiveness checks. `@chanx-js/codegen` treats a constant as always present, so a `switch` over a channel's messages stays exhaustive.

### Heartbeat detection

chanx has no built-in ping handler. A channel is marked `heartbeat: true` only when its schema declares both sending `ping` and receiving `pong`, and the runtime only runs a heartbeat on marked channels. See [Connections](/client/connections#heartbeat).

## JavaScript output

`--emit js` splits each module into a runtime `.js` file and a `.d.ts`:

| File                      | Contains                                             |
| ------------------------- | ---------------------------------------------------- |
| `channels.js`             | The descriptors, with no TypeScript syntax           |
| `channels.d.ts`           | The same descriptors with their full generic types   |
| `schemas.d.ts`            | Message types: declarations only, nothing at runtime |
| `index.js` / `index.d.ts` | Re-exports                                           |

A plain JavaScript project imports `./generated/index.js` and still gets narrowing, address-param checks and topic typing from its editor, or from `checkJs`.

## Validation

Off by default. `--validation zod` also emits zod schemas and checks messages at
runtime; see [Validation](/client/validation).

## Reusing existing types

`--reuse-from` imports payload types you already have instead of generating them; see
[Reusing existing types](/client/reusing-types).

## Your own hooks

Codegen emits framework-neutral descriptors, not hooks: a descriptor already carries the address, params, topics and message types, so `useChannel(notifications)` is fully typed as it is. The hooks worth having carry your app's defaults (a token, when to connect, how to buffer), which a generator cannot know. Write them as thin wrappers; see [React](/client/integrations/react#your-own-hooks), [Vue](/client/integrations/vue#your-own-composables), [Svelte](/client/integrations/svelte#your-own-stores) and [Solid](/client/integrations/solid#your-own-primitives).

## Name clashes

Names come from the schema by case conversion, so `chat-room` and `chat_room` both become `ChatRoom`. When two channels, topics or schemas would produce the same identifier, generation stops with an error naming both, instead of writing code that does not compile. Rename one on the server.

## Keeping it current

Commit the generated files and regenerate in CI; a `git diff --exit-code` afterwards fails the build when the server's schema has changed without the client being regenerated.
