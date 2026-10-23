/** A message on the layer. chanx's consumers dispatch on its `type` key. */
export type ChannelMessage = Record<string, unknown>;

export type MessageHandler = (message: ChannelMessage) => void | Promise<void>;

/** A channel this process receives on, from `newChannel()`. */
export interface LayerChannel {
  readonly name: string;
  /** Stop receiving and leave every group the channel joined. */
  close(): Promise<void>;
}

/**
 * Python channels' layer API (`new_channel`, `send`, `group_add`, `group_discard`,
 * `group_send`, `flush`), delivering through a handler instead of `receive()`.
 */
export interface ChannelLayer {
  newChannel(
    handler: MessageHandler,
    options?: { prefix?: string },
  ): Promise<LayerChannel>;
  send(channel: string, message: ChannelMessage): Promise<void>;
  /** Only channels created by this layer instance can join. */
  groupAdd(group: string, channel: string): Promise<void>;
  groupDiscard(group: string, channel: string): Promise<void>;
  groupSend(group: string, message: ChannelMessage): Promise<void>;
  /** Forget every channel and group and close connections; usable again afterwards. */
  flush(): Promise<void>;
}

export interface LayerOptions {
  /** Receives errors thrown by handlers or raised while decoding. Defaults to `console.error`. */
  onError?: (error: unknown) => void;
}
