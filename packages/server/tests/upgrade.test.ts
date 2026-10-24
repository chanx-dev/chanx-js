import { describe, expect, it, vi } from 'vitest';

import type { AcceptedUpgrade, ConnectRequest } from '../src';
import { AuthenticationError, consumer, createChanx } from '../src';

function app(
  authenticate: (request: ConnectRequest) => unknown,
  rejectBeforeUpgrade = true,
) {
  const logger = { error: vi.fn(), warn() {} };
  const connected: object[] = [];
  const chanx = createChanx({
    consumers: [
      consumer('/ws/{room}', {
        name: 'guarded',
        authenticate: authenticate as () => { name: string },
        rejectBeforeUpgrade,
        onConnect: (ctx) => void connected.push(ctx.conn),
      }),
    ],
    logger,
  });
  return { chanx, logger, connected };
}

function serve(chanx: ReturnType<typeof app>['chanx'], upgrade: AcceptedUpgrade) {
  const sent: unknown[] = [];
  const session = chanx.connect(upgrade, {
    send: (data) => sent.push(JSON.parse(data)),
    close() {},
  })!;
  return { session, sent };
}

describe('chanx.upgrade', () => {
  it('accepts without authenticating when the consumer does not opt in', async () => {
    const authenticate = vi.fn(() => false);
    const { chanx } = app(authenticate, false);

    expect(await chanx.upgrade({ url: '/ws/lobby' })).toMatchObject({ accepted: true });
    expect(authenticate).not.toHaveBeenCalled();
    expect(await chanx.upgrade({ url: '/elsewhere' })).toBeUndefined();
  });

  it('refuses with 401 and the authentication message data when authenticate says no', async () => {
    const { chanx } = app(() => false);
    expect(await chanx.upgrade({ url: '/ws/lobby' })).toEqual({
      accepted: false,
      status: 401,
      statusText: 'Unauthorized',
      body: JSON.stringify({ detail: 'Authentication credentials were not provided.' }),
    });
  });

  it("refuses with an AuthenticationError's own status and data", async () => {
    const { chanx } = app(() => {
      throw new AuthenticationError({
        status: 403,
        statusText: 'Forbidden',
        data: { detail: 'Banned' },
      });
    });
    expect(await chanx.upgrade({ url: '/ws/lobby' })).toEqual({
      accepted: false,
      status: 403,
      statusText: 'Forbidden',
      body: '{"detail":"Banned"}',
    });
  });

  it('refuses with 500, and logs, when authenticate crashes', async () => {
    const { chanx, logger } = app(() => {
      throw new Error('database down');
    });
    expect(await chanx.upgrade({ url: '/ws/lobby' })).toMatchObject({
      accepted: false,
      status: 500,
    });
    expect(logger.error).toHaveBeenCalledWith(
      'chanx: authentication raised',
      expect.any(Error),
    );
  });

  it('serves an accepted upgrade without authenticating again, on the same object', async () => {
    const seen: ConnectRequest[] = [];
    const authenticate = vi.fn(
      (request: ConnectRequest) => (seen.push(request), { name: 'ann' }),
    );
    const { chanx, connected } = app(authenticate);

    const upgrade = (await chanx.upgrade({
      url: '/ws/lobby?token=ok',
    })) as AcceptedUpgrade;
    const { session, sent } = serve(chanx, upgrade);

    expect(await session.ready).toBe(true);
    expect(authenticate).toHaveBeenCalledOnce();
    expect(sent[0]).toMatchObject({
      action: 'authentication',
      payload: { status_code: 200 },
    });
    expect(connected[0]).toBe(seen[0]);
    expect((connected[0] as { user: unknown; params: unknown }).user).toEqual({
      name: 'ann',
    });
    expect((connected[0] as { params: unknown }).params).toEqual({ room: 'lobby' });
  });
});
