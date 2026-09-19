import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket } from 'ws';

import { CollaborativeServer } from './index';
import type { CollaborativeDocumentState, CollaborativeServerMessage, PersistedDocument } from './types';

interface TestClient {
  socket: WebSocket;
  messages: CollaborativeServerMessage[];
  waitForMessage: (matches: (message: CollaborativeServerMessage) => boolean) => Promise<CollaborativeServerMessage>;
}

function connect(url: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const messages: CollaborativeServerMessage[] = [];
    const waiters: Array<{
      matches: (message: CollaborativeServerMessage) => boolean;
      resolve: (message: CollaborativeServerMessage) => void;
    }> = [];

    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as CollaborativeServerMessage;
      messages.push(message);
      const waiter = waiters.find(({ matches }) => matches(message));
      if (waiter) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    });
    socket.once('open', () => {
      resolve({
        socket,
        messages,
        waitForMessage: (matches) => {
          const message = messages.find(matches);
          if (message) {
            return Promise.resolve(message);
          }
          return new Promise((resolveMessage) => waiters.push({ matches, resolve: resolveMessage }));
        },
      });
    });
    socket.once('error', reject);
  });
}

function closeClient(client: TestClient): Promise<void> {
  return new Promise((resolve) => {
    if (client.socket.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    client.socket.once('close', () => resolve());
    client.socket.close();
  });
}

test('syncs form fields once over WebSocket and broadcasts persisted form state', async (context) => {
  let persisted: PersistedDocument = { data: {}, revision: 0, updatedAt: null };
  const server = new CollaborativeServer({
    port: 0,
    persistence: {
      load: () => persisted,
      patch: (_formId, changes) => {
        persisted = {
          data: { ...persisted.data, ...changes },
          revision: persisted.revision + 1,
          updatedAt: '2026-09-18T00:00:00.000Z',
        };
        return persisted;
      },
    },
  });
  await server.whenReady();
  context.after(() => server.close());

  const endpoint = `ws://127.0.0.1:${server.port}/form/project-brief`;
  const editorOne = await connect(endpoint);
  const editorTwo = await connect(endpoint);
  context.after(async () => {
    await Promise.all([closeClient(editorOne), closeClient(editorTwo)]);
  });

  const remoteUpdate = editorTwo.waitForMessage((message) => message.type === 'update');
  editorOne.socket.send(JSON.stringify({ type: 'update', field: 'title', value: 'Launch plan' }));
  assert.deepEqual(await remoteUpdate, {
    type: 'update',
    documentId: 'project-brief',
    field: 'title',
    value: 'Launch plan',
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(editorOne.messages.some((message) => message.type === 'update'), false);

  const persistedAtOne = editorOne.waitForMessage((message) => message.type === 'persisted');
  const persistedAtTwo = editorTwo.waitForMessage((message) => message.type === 'persisted');
  const response = await fetch(`http://127.0.0.1:${server.port}/api/documents/project-brief`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes: { title: 'Launch plan' } satisfies CollaborativeDocumentState }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), await persistedAtOne);
  assert.deepEqual(await persistedAtTwo, await persistedAtOne);
});

test('rejects invalid form patches before calling persistence', async (context) => {
  const server = new CollaborativeServer({
    port: 0,
    persistence: {
      load: () => ({ data: {}, revision: 0, updatedAt: null }),
      patch: () => assert.fail('persistence should not receive invalid patches'),
    },
  });
  await server.whenReady();
  context.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${server.port}/api/documents/project-brief`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes: {} }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'changes must contain supported field values' });
});