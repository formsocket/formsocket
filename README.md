# Formsocket

Formsocket is a lightweight collaborative form framework for React applications and Python services. It gives you a small abstraction over React Hook Form plus a WebSocket server so that form fields can sync across clients with a simple, last-write-wins model. The same protocol is also available in a FastAPI reference backend for Python developers.

## Features

- Real-time collaboration for individual form fields
- WebSocket room-based realtime syncing
- React Hook Form integration
- FastAPI/Python reference backend support
- Debounced HTTP autosave with retry
- Revisioned persistence adapters
- Cursor-protection logic to prevent field focus jumping during active editing
- Self-hostable backend server

## Packages

This monorepo includes three supported integration paths:

- `@formsocket/react` — frontend collaborative form hooks and provider
- `@formsocket/server` — Node WebSocket router/state manager
- `formsocket-python` — FastAPI reference backend implementing the same client protocol

The Python package lives in `packages/python` and is designed to work with the same form IDs, real-time update messages, and persistence endpoints used by the JavaScript client.

## Installation

### JavaScript

```bash
npm install @formsocket/react @formsocket/server
```

### Python

From this repository:

```bash
python -m venv .venv
.venv/bin/pip install -e "packages/python[test]"
```

Or from a Python project that depends on the package:

```bash
pip install formsocket-python
```

## Run the demo

The included project brief demo uses a SQLite database, one-second autosave, and visible connection/save status.

```bash
npm install
npm run dev
```

Open the Vite URL shown in the terminal, then select **Open second editor** to test concurrent changes. Both windows use the same document ID from the `?document=` query parameter. Changes persist to `formsocket.sqlite`; restart the server and reopen the document to verify they reload.

The same collaborative protocol is also available in the Python backend. If you are building a Python stack, run the FastAPI app with:

```bash
python -m venv .venv
.venv/bin/pip install -e "packages/python[test]"
.venv/bin/uvicorn formsocket_python.app:app --host 0.0.0.0 --port 8080
```

## Quick start

### 1. Start the server

```ts
import { CollaborativeServer } from '@formsocket/server';

const server = new CollaborativeServer({
  port: 8080,
  allowedOrigins: ['http://localhost:5173'],
  persistence: {
    load: async (documentId) => database.load(documentId),
    patch: async (documentId, changes) => database.patch(documentId, changes),
  },
});
```

### 2. Use the React provider

```tsx
import React from 'react';
import { useForm } from 'react-hook-form';
import {
  CollaborativeProvider,
  useCollaborativeField,
  useCollaborativeStatus,
} from '@formsocket/react';

type FormValues = {
  title: string;
  notes: string;
};

export function MyForm() {
  const form = useForm<FormValues>({
    defaultValues: {
      title: '',
      notes: '',
    },
  });

  return (
    <CollaborativeProvider<FormValues>
      url="ws://localhost:8080/form/demo-document"
      persistenceUrl="http://localhost:8080/api/documents/demo-document"
      autosaveMs={1000}
      form={form}
    >
      <input {...form.register('title')} {...useCollaborativeField('title')} />
      <textarea {...form.register('notes')} {...useCollaborativeField('notes')} />
    </CollaborativeProvider>
  );
}
```

Components rendered inside `CollaborativeProvider` can call `useCollaborativeStatus()` to display connection state, pending autosaves, the latest save time, and persistence errors.

Realtime field changes travel over WebSocket. Initial loading and durable autosaves use HTTP `GET` and `PATCH`; successful patches are broadcast to connected clients with the new database revision. The route parameter (`demo-document` above) is an opaque **form instance ID**: it identifies one shared set of form values.

## Python backend

The Python reference server is compatible with `@formsocket/react`; point the provider at the same paths using the Python server's host and port.

This is the recommended option for Python developers who want to run the same collaborative form protocol in a FastAPI service without rewriting the backend in Node.

```bash
python -m venv .venv
.venv/bin/pip install -e "packages/python[test]"
.venv/bin/uvicorn formsocket_python.app:app --host 0.0.0.0 --port 8080
```

`create_app()` accepts a `FormStore` implementation with async `load(form_id)` and `patch(form_id, changes)` methods. `InMemoryFormStore` is the default for development; production applications should supply a database-backed store with atomic revision increments.

This makes Python a first-class option for Formsocket integrations, especially when the rest of your stack is already FastAPI-based.

Run the Python protocol tests with:

```bash
.venv/bin/python -m pytest packages/python/tests
```

## Collaboration model

- Call `useCollaborativeField` for each collaborative `<input>` or `<textarea>`. Local user input sends one realtime update and schedules one debounced save.
- Remote updates use React Hook Form's programmatic `setValue`; they do not invoke the input `onChange` handler, schedule another PATCH, or echo an update back through WebSocket.
- The server excludes the originating socket when forwarding realtime `update` messages. A successful PATCH then broadcasts the authoritative persisted form state to every connected editor.
- Values are scalar `string`, `number`, `boolean`, `null`, or `undefined`. Nested objects, arrays, files, and rich-text merging are outside this MVP contract.
- Concurrent edits use field-level last-write-wins. Presence locks reduce conflicting edits to the same field but are not a transactional guarantee.
- A change is durable only after its PATCH succeeds. The client retries failed autosaves while it remains open; this MVP does not provide offline queues or guaranteed delivery after a tab/process crash.

## Notes

- This package is designed for self-hosted collaborative forms rather than CRDT-based text merging.
- Remote updates are ignored for the field currently focused by the local user to prevent cursor jumps.

## License

MIT
