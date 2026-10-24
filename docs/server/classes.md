# Classes

Every consumer and topic can be written as a class instead of with the builder. Both
produce the same definition, so dispatch, AsyncAPI and the client see no difference.
Reach for a class when consumers share logic through a base class, or when a hook reads
better as a method to override.

## Consumers

One instance serves one connection, so its fields are per-connection state:

```ts
import {
  AsyncJsonWebsocketConsumer,
  Consumer,
  On,
} from '@chanx-js/server';

@Consumer('/ws/chat/{room}', { name: 'chat', emits: [Notice] })
class ChatConsumer extends AsyncJsonWebsocketConsumer<User> {
  messages = 0;

  @On(PingMessage, { output: PongMessage })
  ping() {
    return PongMessage.create();
  }

  @On(Chat)
  async chat(m: MessageOf<typeof Chat>) {
    this.messages++;
    await this.push(
      Notice.create({
        text: `${this.params.room}: ${m.payload.text}`,
      }),
    );
  }

  override onConnect() {
    console.log(`${this.conn.user.name} joined`);
  }
}

createChanx({ consumers: [ChatConsumer] });
```

The decorators work with standard decorators and with `experimentalDecorators`. A
subclass method overrides the handler of the same name, decorated or not, and two
methods handling one action are an error. `@OnEvent` handles events; the error hooks
are methods to override.

## Topics

One instance serves one subscription. The class name names the layer group, so two
servers sharing a layer must use the same name:

```ts
import { On, Topic } from '@chanx-js/server';

class RoomTopic extends Topic {
  static override pattern = 'room:{room_name}';
  static override passthrough = [RoomEvent];

  override authorize() {
    return this.params.room_name !== 'secret';
  }

  @On(Post, { output: Posted })
  async post(m: MessageOf<typeof Post>) {
    await this.publish(RoomEvent.create(m.payload));
    return Posted.create(m.payload);
  }
}

consumer('/ws/hub', { name: 'hub', topics: [RoomTopic] });
```

`topicConsumer(RoomTopic, '/ws/room/{room_name}')` serves a class topic on its own
route.

## On NestJS

[`@chanx-js/nestjs`](/server/integrations/nestjs) takes the same approach with its own
decorators, `@ChanxConsumer` and `@ChanxTopic`, on injectable classes: a gateway gets
Nest's DI, guards and pipes as well.
