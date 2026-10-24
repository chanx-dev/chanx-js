import type { ChanxMessage } from '@chanx-js/protocol';
import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest';

import { createClient } from '../src/core/client';
import type { ChannelConnection } from '../src/core/connection';
import { createChannelController } from '../src/core/controller';
import { defineChannel, defineTopic } from '../src/core/descriptor';
import { resetSockets } from '../src/core/socket';
import type { UseChannelResult } from '../src/react/useChannel';
import { FakeSocket, fakeFactory } from './fake-socket';

type Ping = { action: 'ping'; payload?: null };
type Say = { action: 'say'; payload: { text: string } };
type Pong = { action: 'pong'; payload?: null };
type Said = { action: 'said'; payload: { text: string } };
type Post = { action: 'post'; payload: { body: string } };
type Posted = { action: 'posted'; payload: { body: string } };

const roomTopic = defineTopic<Post, Posted, { post: Posted }>()({
  name: 'room_topic',
  pattern: 'room:{room_name}',
});

const chat = defineChannel<Ping | Say, Pong | Said, { ping: Pong }>()({
  name: 'chat',
  address: '/ws/chat',
  topics: { roomTopic },
});

const untyped = defineChannel<Ping, Pong>()({ name: 'untyped', address: '/ws/untyped' });

const client = () =>
  createClient({
    baseUrl: 'ws://test.local',
    socketFactory: fakeFactory,
    closeDelay: 0,
    heartbeat: false,
  });

beforeEach(() => {
  resetSockets();
  FakeSocket.reset();
});

describe('typed replies', () => {
  it('resolves a request with the reply its action declares', async () => {
    const connection = client().connect(chat);
    FakeSocket.last.accept();

    const pending = connection.request({ action: 'ping' });
    const ref = FakeSocket.last.lastSent.ref as string;
    FakeSocket.last.receive({ version: 1, ref, action: 'pong', payload: null });

    expectTypeOf(pending).resolves.toEqualTypeOf<Pong>();
    await expect(pending).resolves.toEqual({ action: 'pong', payload: null });
  });

  it('types an action without a declared reply as any message', () => {
    const connection = client().connect(chat);

    expectTypeOf(connection.request<'say'>).returns.toEqualTypeOf<
      Promise<ChanxMessage>
    >();
  });

  it('types a topic request by the topic’s replies', () => {
    const room = client()
      .connect(chat)
      .topic(roomTopic.with({ room_name: 'lobby' }));

    expectTypeOf(room.request<'post'>).returns.toEqualTypeOf<Promise<Posted>>();
  });

  it('carries the replies through controllers and bindings', () => {
    const controller = createChannelController(client(), chat);
    type Result = UseChannelResult<Ping | Say, Pong | Said, { ping: Pong }>;

    expectTypeOf(controller.request<'ping'>).returns.toEqualTypeOf<Promise<Pong>>();
    expectTypeOf<ReturnType<Result['request']>>().toEqualTypeOf<
      Promise<Pong | ChanxMessage>
    >();
  });

  it('keeps a descriptor without replies answering any message', () => {
    const connection = client().connect(untyped);

    expectTypeOf(connection.request<'ping'>).returns.toEqualTypeOf<
      Promise<ChanxMessage>
    >();
  });
});

// Checked by `pnpm typecheck`, never run: a typed request still sends only what the
// channel receives. Excess-property checks need a direct call with a literal.
export function sendsOnlyWhatTheServerReceives(
  connection: ChannelConnection<Ping | Say, Pong | Said, { ping: Pong }>,
): void {
  void connection.request({ action: 'say', payload: { text: 'hi' } });
  // @ts-expect-error a misspelt field
  void connection.request({ action: 'say', payload: { txt: 'hi' } });
  // @ts-expect-error a field the message does not have
  void connection.request({ action: 'say', payload: { text: 'hi', extra: 1 } });
  // @ts-expect-error an action the server does not receive
  void connection.request({ action: 'shout' });
}
