import { patternParams } from '@chanx-js/protocol';

import { camelize, camelizeKey, decamelizeKey } from './case';
import type { ConsumerDefinition, HandlerDefinition } from './consumer';
import { eventHandlersOf } from './consumer';
import type { AnyMessageDefinition } from './messages';
import type { JsonSchema, StandardSchemaV1 } from './standard-schema';
import type { TopicDefinition } from './topic';
import { topicDefinitionOf, topicsOf } from './topic';

export interface AsyncAPIOptions {
  title?: string;
  version?: string;
  description?: string;
  /** The server's host, such as `api.example.com`. */
  serverUrl?: string;
  /** `ws` or `wss`. */
  serverProtocol?: string;
}

export type AsyncAPIDocument = Record<string, unknown>;

/** A route as AsyncAPI documents it: a consumer, or a topic at a consumer's address. */
interface Entry {
  channel: string;
  /** The name an operation is prefixed with when its own name is taken, as chanx's `snake_name`. */
  owner: string;
  path: string;
  description?: string;
  tags?: readonly string[];
  topic?: TopicDefinition;
  handlers: ReadonlyMap<string, HandlerDefinition>;
  events: ReadonlyMap<string, HandlerDefinition>;
  emits: readonly AnyMessageDefinition[];
}

/**
 * AsyncAPI 3 for these consumers, laid out as chanx's generator lays it out, so
 * `@chanx-js/codegen` reads a Node server's schema as it reads a Python one's.
 */
export function generateAsyncAPI(
  consumers: readonly ConsumerDefinition[],
  {
    title = 'AsyncAPI Documentation',
    version = '1.0.0',
    description,
    serverUrl = 'localhost:8000',
    serverProtocol = 'ws',
  }: AsyncAPIOptions = {},
  { camelize: camel = false }: { camelize?: boolean } = {},
): AsyncAPIDocument {
  const entries = consumers.flatMap(entriesOf);
  const components = new Components();
  const channels: Record<string, unknown> = {};
  const operations: Record<string, unknown> = {};

  for (const entry of entries) {
    const messages = new Map<string, AnyMessageDefinition>();
    const add = (message: AnyMessageDefinition) =>
      messages.set(messageKey(message), message);
    for (const handler of entry.handlers.values()) {
      add(handler.message);
      handler.outputs.forEach(add);
    }
    // As chanx: an event's input stays server-side; what reaches the client is its output.
    for (const handler of entry.events.values()) handler.outputs.forEach(add);
    entry.emits.forEach(add);

    const params = patternParams(entry.path);
    channels[entry.channel] = {
      address: entry.path,
      title: entry.channel,
      ...(entry.description !== undefined && { description: entry.description }),
      ...(params.length && {
        parameters: Object.fromEntries(
          params.map((name) => [
            name,
            { description: `Path parameter for ${name} (str)` },
          ]),
        ),
      }),
      ...(entry.topic && {
        'x-topic': {
          name: snakeName(entry.topic.name),
          pattern: entry.topic.pattern,
          parameters: patternParams(entry.topic.pattern),
        },
      }),
      messages: Object.fromEntries(
        [...messages.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([key, message]) => [key, { $ref: components.message(message) }]),
      ),
      ...(entry.tags?.length && { tags: entry.tags.map((name) => ({ name })) }),
    };

    const ref = (message: AnyMessageDefinition) => ({
      $ref: `#/channels/${entry.channel}/messages/${messageKey(message)}`,
    });
    const operation = (
      name: string,
      action: 'receive' | 'send',
      body: Record<string, unknown>,
    ) => {
      const key = name in operations ? `${entry.owner}_${name}` : name;
      operations[key] = {
        action,
        channel: { $ref: `#/channels/${entry.channel}` },
        ...body,
      };
    };
    for (const handler of entry.handlers.values()) {
      operation(operationName(handler), 'receive', {
        ...documentation(handler),
        messages: [ref(handler.message)],
        ...(handler.outputs.length && {
          reply: {
            channel: { $ref: `#/channels/${entry.channel}` },
            messages: handler.outputs.map(ref),
          },
        }),
      });
    }
    for (const handler of entry.events.values()) {
      operation(operationName(handler), 'send', {
        ...documentation(handler),
        ...(handler.outputs.length && { messages: handler.outputs.map(ref) }),
      });
    }
    // Node consumers can declare what they push; chanx consumers have no such list.
    if (entry.emits.length) {
      operation(`${entry.owner}_emits`, 'send', {
        description: '',
        summary: 'Messages the server pushes',
        messages: entry.emits.map(ref),
      });
    }
  }

  const document: AsyncAPIDocument = {
    asyncapi: '3.0.0',
    info: { title, version, ...(description !== undefined && { description }) },
    servers: { [environment(serverUrl)]: { host: serverUrl, protocol: serverProtocol } },
    channels,
    operations,
    components: {
      messages: sorted(components.messages),
      schemas: sorted(components.schemas),
    },
  };
  return camel ? camelizeDocument(document) : document;
}

function entriesOf(definition: ConsumerDefinition): Entry[] {
  const { options } = definition;
  const consumerEntry: Entry = {
    channel: options.name,
    owner: options.name,
    path: definition.path,
    description: options.description,
    tags: options.tags,
    handlers: definition.handlers,
    events: eventHandlersOf(definition),
    emits: options.emits ?? [],
  };
  const topicEntry = (topic: TopicDefinition, channel: string): Entry => ({
    channel,
    owner: snakeName(topic.name),
    path: definition.path,
    description: topic.options.description,
    topic,
    handlers: topic.handlers,
    events: eventHandlersOf(topic),
    emits: [],
  });

  // A route dedicated to one topic is that topic, not a host for it.
  if (definition.defaultTopic) {
    const topic = topicDefinitionOf(definition.defaultTopic);
    return [topicEntry(topic, snakeName(topic.name))];
  }
  const hosted = topicsOf(definition).map((topic) =>
    topicEntry(topic, `${options.name}_${snakeName(topic.name)}`),
  );
  const ownHandlers = definition.handlers.size > 0 || definition.topics.length === 0;
  return ownHandlers ? [consumerEntry, ...hosted] : hosted;
}

/** Operation names follow a Python handler's method name. */
function operationName(handler: HandlerDefinition): string {
  return handler.name ?? `handle_${handler.message.action}`;
}

function documentation(handler: HandlerDefinition) {
  return {
    description: handler.description ?? '',
    summary: handler.summary ?? '',
    ...(handler.tags?.length && { tags: handler.tags.map((name) => ({ name })) }),
  };
}

function messageKey(message: AnyMessageDefinition): string {
  return decamelizeKey(message.title);
}

const snakeName = (name: string) => decamelizeKey(name);

class Components {
  readonly messages: Record<string, unknown> = {};
  readonly schemas: Record<string, unknown> = {};

  message(message: AnyMessageDefinition): string {
    const key = messageKey(message);
    if (!(key in this.messages)) {
      this.messages[key] = {
        payload: { $ref: this.schema(message.title, this.messageSchema(message)) },
      };
    }
    return `#/components/messages/${key}`;
  }

  private messageSchema(message: AnyMessageDefinition): JsonSchema {
    const payload = message.payload
      ? this.payloadSchema(message.payload)
      : { default: null, title: 'Payload', type: 'null' };
    return {
      ...(message.description !== undefined && { description: message.description }),
      properties: {
        action: {
          const: message.action,
          default: message.action,
          title: 'Action',
          type: 'string',
        },
        payload,
      },
      ...(message.payload && { required: ['payload'] }),
      title: message.title,
      type: 'object',
    };
  }

  /** The payload's JSON Schema, a titled one hoisted into a component as pydantic models are. */
  private payloadSchema(schema: StandardSchemaV1): JsonSchema {
    // The input side, as pydantic's default validation mode: defaults are not required.
    const generated = schema['~standard'].jsonSchema?.input({ target: 'draft-2020-12' });
    if (!generated) return {};
    const {
      $schema,
      $defs = {},
      ...root
    } = rewriteRefs(generated) as JsonSchema & {
      $defs?: Record<string, JsonSchema>;
    };
    for (const [name, definition] of Object.entries($defs)) this.schema(name, definition);
    return typeof root.title === 'string'
      ? { $ref: this.schema(root.title, root) }
      : root;
  }

  schema(name: string, schema: JsonSchema): string {
    const existing = this.schemas[name];
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(schema)) {
      throw new Error(
        `Two different schemas are titled "${name}"; give one another title`,
      );
    }
    this.schemas[name] = schema;
    return `#/components/schemas/${name}`;
  }
}

function rewriteRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteRefs);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === '$ref' && typeof item === 'string'
        ? item.replace(/^#\/\$defs\//, '#/components/schemas/')
        : rewriteRefs(item),
    ]),
  );
}

function environment(host: string): string {
  const local = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'];
  return local.some((name) => host.toLowerCase().includes(name))
    ? 'development'
    : 'production';
}

function sorted<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));
}

// chanx's camelization: names and properties, but schema names stay class names.
function camelizeDocument(document: AsyncAPIDocument): AsyncAPIDocument {
  const renameKeys = (record: unknown) =>
    Object.fromEntries(
      Object.entries(record as object).map(([key, value]) => [camelizeKey(key), value]),
    );
  const fixRefs = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(fixRefs);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === '$ref' && typeof item === 'string' ? camelizeRef(item) : fixRefs(item),
      ]),
    );
  };
  const channels = renameKeys(document.channels) as Record<
    string,
    Record<string, unknown>
  >;
  for (const channel of Object.values(channels))
    channel.messages = renameKeys(channel.messages);
  const components = document.components as {
    messages: unknown;
    schemas: Record<string, JsonSchema>;
  };
  return fixRefs({
    ...document,
    channels,
    operations: renameKeys(document.operations),
    components: {
      messages: renameKeys(components.messages),
      schemas: Object.fromEntries(
        Object.entries(components.schemas).map(([name, schema]) => [
          name,
          camelizeSchema(schema),
        ]),
      ),
    },
  }) as AsyncAPIDocument;
}

function camelizeSchema(schema: JsonSchema): JsonSchema {
  const result = camelize(schema) as JsonSchema;
  if (Array.isArray(schema.required)) {
    result.required = schema.required.map((name) =>
      typeof name === 'string' ? camelizeKey(name) : name,
    );
  }
  return result;
}

function camelizeRef(ref: string): string {
  const parts = ref.split('/');
  const schemaIndex = parts.indexOf('schemas');
  return parts
    .map((part, index) =>
      index <= 1 ||
      ['channels', 'messages', 'operations', 'components', 'schemas'].includes(part) ||
      (schemaIndex >= 0 && index === schemaIndex + 1)
        ? part
        : camelizeKey(part),
    )
    .join('/');
}
