import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { AsyncAPIDocument, Credential } from '../src';
import { consumer, createChanx, defineMessage, topic } from '../src';

// Titled as chanx's test names its classes.
const SecureAsk = defineMessage('secure_ask', z.string(), { title: 'SecureAsk' });
const SecureAnswer = defineMessage('secure_answer', z.string(), {
  title: 'SecureAnswer',
});

// As chanx's tests/core/asyncapi/test_security.py.
const credentials: Credential[] = [
  { name: 'token', location: 'query', description: 'Access token' },
  { name: 'Authorization', location: 'header' },
  { name: 'sessionid', location: 'cookie' },
];
const secure = (options: { credentials?: Credential[] } = { credentials }) =>
  consumer('/ws/secure', { name: 'secure_room', ...options }).on(
    SecureAsk,
    { output: SecureAnswer },
    (m) => SecureAnswer.create(m.payload),
  );

const SCHEME_REFS = [
  { $ref: '#/components/securitySchemes/query_token' },
  { $ref: '#/components/securitySchemes/header_authorization' },
  { $ref: '#/components/securitySchemes/cookie_sessionid' },
];

// Payload schemas aside: pydantic's and Zod's JSON Schema differ.
const comparable = ({
  components: { schemas, ...components },
  ...rest
}: AsyncAPIDocument) => JSON.stringify({ ...rest, components }, null, 2);

describe('AsyncAPI credentials, against chanx', () => {
  it('documents the same schemes, bindings and security, in the same order', async () => {
    const python = JSON.parse(
      await readFile(
        new URL('./__fixtures__/chanx-secure-asyncapi.json', import.meta.url),
        'utf8',
      ),
    ) as AsyncAPIDocument;
    const node = createChanx({ consumers: [secure()] }).asyncapi();

    expect(comparable(node)).toBe(comparable(python));
  });
});

describe('AsyncAPI credentials', () => {
  it('keep scheme names when camelized', () => {
    const doc = createChanx({ consumers: [secure()], camelize: true }).asyncapi();
    expect(doc.operations.handleSecureAsk?.security).toEqual(SCHEME_REFS);
    expect(Object.keys(doc.components.securitySchemes!)).toEqual([
      'query_token',
      'header_authorization',
      'cookie_sessionid',
    ]);
  });

  it('let a declared scheme replace the one a credential adds', () => {
    const declared = { type: 'httpApiKey', name: 'token', in: 'query', 'x-note': 'mine' };
    const doc = createChanx({ consumers: [secure()] }).asyncapi({
      securitySchemes: { query_token: declared, oauth: { type: 'oauth2' } },
    });
    expect(doc.components.securitySchemes?.query_token).toEqual(declared);
    expect(doc.components.securitySchemes?.oauth).toEqual({ type: 'oauth2' });
  });

  it('let declared servers replace the default one', () => {
    const servers = {
      production: {
        host: 'api.example.com',
        protocol: 'wss',
        description: 'Production',
        security: [{ $ref: '#/components/securitySchemes/query_token' }],
      },
    };
    const chanx = createChanx({ consumers: [secure()] });
    expect(chanx.asyncapi({ servers }).servers).toEqual(servers);
    expect(chanx.asyncapi().servers).toEqual({
      development: { host: 'localhost:8000', protocol: 'ws' },
    });
  });

  it('add nothing when a consumer declares none', () => {
    const doc = createChanx({ consumers: [secure({})] }).asyncapi();
    expect(doc.components.securitySchemes).toBeUndefined();
    expect(Object.values(doc.channels).every((c) => !c.bindings)).toBe(true);
    expect(Object.values(doc.operations).every((o) => !o.security)).toBe(true);
  });

  it('add no binding for cookies alone', () => {
    const doc = createChanx({
      consumers: [secure({ credentials: [{ name: 'sessionid', location: 'cookie' }] })],
    }).asyncapi();
    expect(doc.channels.secure_room?.bindings).toBeUndefined();
    expect(doc.operations.handle_secure_ask?.security).toEqual([
      { $ref: '#/components/securitySchemes/cookie_sessionid' },
    ]);
  });

  it("put a hosting consumer's credentials on its topics", () => {
    const Post = defineMessage('post', z.string());
    const roomTopic = topic('room:{name}').on(Post, () => undefined);
    const hub = consumer('/ws/hub', { name: 'hub', credentials, topics: [roomTopic] });

    const doc = createChanx({ consumers: [hub] }).asyncapi();

    expect(doc.channels.hub_room_topic?.bindings?.ws.query).toBeDefined();
    expect(doc.operations.handle_post?.security).toEqual(SCHEME_REFS);
  });
});
