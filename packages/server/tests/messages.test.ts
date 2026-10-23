import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { PingMessage, defineMessage, defineMessages } from '../src';

describe('defineMessage', () => {
  it('builds messages with and without a payload', () => {
    const Chat = defineMessage('chat', z.object({ message: z.string() }));

    expect(Chat.create({ message: 'hi' })).toEqual({
      action: 'chat',
      payload: { message: 'hi' },
    });
    expect(PingMessage.create()).toEqual({ action: 'ping', payload: null });
  });

  it('names the AsyncAPI component after the action, unless told otherwise', () => {
    expect(defineMessage('chat_notification').title).toBe('ChatNotificationMessage');
    expect(defineMessage('room_event', z.object({}), { title: 'RoomEvent' }).title).toBe(
      'RoomEvent',
    );
    expect(defineMessage('ping', { title: 'Ping' }).title).toBe('Ping');
  });
});

describe('defineMessages', () => {
  it('names each message by its key', () => {
    const messages = defineMessages({
      chat: z.object({ message: z.string() }),
      ping: null,
      room_event: { payload: z.object({ body: z.string() }), title: 'RoomEvent' },
      presence: { payload: null, title: 'Presence' },
    });

    expect(messages.chat.action).toBe('chat');
    expect(messages.ping.payload).toBeNull();
    expect(messages.room_event.title).toBe('RoomEvent');
    expect(messages.presence).toMatchObject({
      action: 'presence',
      payload: null,
      title: 'Presence',
    });
  });
});
