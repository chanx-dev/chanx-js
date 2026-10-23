import type { ChannelMessage, LayerOptions, MessageHandler } from './types';

/**
 * Process-local bookkeeping shared by every layer: which channels live here, which
 * groups they joined, and delivery that never lets a handler's error escape.
 */
export class LocalChannels {
  readonly handlers = new Map<string, MessageHandler>();
  readonly groups = new Map<string, Set<string>>();
  private readonly onError: (error: unknown) => void;

  constructor(options: LayerOptions) {
    this.onError = options.onError ?? console.error;
  }

  requireLocal(channel: string): void {
    if (!this.handlers.has(channel)) {
      throw new Error(
        `groupAdd() needs a channel created by this layer with newChannel(); got "${channel}"`,
      );
    }
  }

  /** Returns true when the group just gained its first member. */
  join(group: string, channel: string): boolean {
    const members = this.groups.get(group);
    if (members) {
      members.add(channel);
      return false;
    }
    this.groups.set(group, new Set([channel]));
    return true;
  }

  /** Returns true when the group just lost its last member. */
  leave(group: string, channel: string): boolean {
    const members = this.groups.get(group);
    if (!members?.delete(channel)) return false;
    if (members.size > 0) return false;
    this.groups.delete(group);
    return true;
  }

  /** Remove a channel everywhere; returns the groups it left empty. */
  remove(channel: string): string[] {
    this.handlers.delete(channel);
    return [...this.groups.keys()].filter((group) => this.leave(group, channel));
  }

  deliver(channel: string, message: ChannelMessage): void {
    const handler = this.handlers.get(channel);
    if (!handler) return;
    try {
      void Promise.resolve(handler(message)).catch(this.onError);
    } catch (error) {
      this.onError(error);
    }
  }

  /** Each member gets its own copy, as each would after deserializing. */
  deliverToGroup(group: string, message: ChannelMessage): void {
    for (const channel of this.groups.get(group) ?? []) {
      this.deliver(channel, structuredClone(message));
    }
  }

  report(error: unknown): void {
    this.onError(error);
  }

  clear(): void {
    this.handlers.clear();
    this.groups.clear();
  }
}
