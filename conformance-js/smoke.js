// @ts-check
/** Runs `server.js` under plain Node, no transpiler, against the built packages. */
import assert from 'node:assert/strict';
import { connect } from '@chanx-js/server/testing';

import { chanx } from './server.js';

const client = connect(chanx, '/ws/chat/lobby');
assert.equal(await client.ready, true);

assert.equal((await client.request({ action: 'ping' })).action, 'pong');

client.send({ action: 'chat', payload: { text: 'hello' } });
assert.deepEqual(await client.receive(), {
  action: 'notice',
  payload: { text: 'lobby: hello' },
});

await client.close();
console.log('plain JavaScript server: ok');
