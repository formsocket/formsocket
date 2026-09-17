import { CollaborativeServer } from './index';

const port = Number(process.env.PORT ?? 8080);

new CollaborativeServer({
  port,
  onSave: async (documentId, data) => {
    console.log(`[save] document=${documentId} data=${JSON.stringify(data)}`);
  },
});

console.log(`Collaborative server started on ws://localhost:${port}`);
