# Formsocket

Formsocket is a lightweight collaborative form framework for React applications. It gives you a small abstraction over React Hook Form and a Node WebSocket server so that form fields can sync across clients with a simple, last-write-wins model.

## Features

- Real-time collaboration for individual form fields
- WebSocket room-based document syncing
- React Hook Form integration
- Debounced save callbacks on the server
- Cursor-protection logic to prevent field focus jumping during active editing
- Self-hostable backend server

## Packages

This monorepo contains two published packages:

- `@formsocket/react` — frontend collaborative form hooks and provider
- `@formsocket/server` — Node WebSocket router/state manager

## Installation

```bash
npm install @formsocket/react @formsocket/server
```

## Quick start

### 1. Start the server

```ts
import { CollaborativeServer } from '@formsocket/server';

const server = new CollaborativeServer({
  port: 8080,
  onSave: async (documentId, data) => {
    console.log('Saved', documentId, data);
  },
});
```

### 2. Use the React provider

```tsx
import React from 'react';
import { useForm } from 'react-hook-form';
import { CollaborativeProvider, useCollaborativeField } from '@formsocket/react';

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
      form={form}
    >
      <input {...form.register('title')} {...useCollaborativeField('title')} />
      <textarea {...form.register('notes')} {...useCollaborativeField('notes')} />
    </CollaborativeProvider>
  );
}
```

## Notes

- This MVP intentionally uses a field-level last-write-wins model.
- It is designed for self-hosted collaborative editing rather than CRDT-based text merging.
- Remote updates are ignored for the field currently focused by the local user to prevent cursor jumps.

## License

MIT
