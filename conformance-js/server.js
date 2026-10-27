// @ts-check
/**
 * A plain-JavaScript server, with no TypeScript syntax anywhere in this file. Checked
 * with `checkJs`, so every `@ts-expect-error` below proves a JS server gets the same
 * handler typing a TS one does, from the published `.d.mts` files alone.
 */
import { z } from 'zod';
import {
  PingMessage,
  PongMessage,
  consumer,
  createChanx,
  defineMessage,
} from '@chanx-js/server';

const Chat = defineMessage('chat', z.object({ text: z.string() }));
const Notice = defineMessage('notice', z.object({ text: z.string() }));
const Undeclared = defineMessage('undeclared', z.object({}));

const chat = consumer('/ws/chat/{room}', { name: 'chat' })
  .on(PingMessage, { output: PongMessage }, () => PongMessage.create())
  .on(Chat, { output: Notice }, async (m, ctx) => {
    // @ts-expect-error `chat` carries no `missing` field.
    void m.payload.missing;

    // @ts-expect-error the route `/ws/chat/{room}` has no `missing` param.
    void ctx.params.missing;

    if (m.payload.text === 'undeclared') {
      // @ts-expect-error `undeclared` is not this handler's `output`.
      await ctx.send(Undeclared.create({}));
    }

    await ctx.send(Notice.create({ text: `${ctx.params.room}: ${m.payload.text}` }));
  });

// @ts-expect-error `text` must be a string.
Chat.create({ text: 1 });

export const chanx = createChanx({ consumers: [chat] });
