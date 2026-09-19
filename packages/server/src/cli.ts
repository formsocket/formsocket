import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { CollaborativeServer } from './index';
import type { CollaborativeDocumentState } from './types';

const port = Number(process.env.PORT ?? 8080);
const databasePath = process.env.DATABASE_PATH ?? resolve(process.env.INIT_CWD ?? process.cwd(), 'formsocket.sqlite');
const database = new DatabaseSync(databasePath);

database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
`);

const columns = database.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>;
if (!columns.some((column) => column.name === 'revision')) {
  database.exec('ALTER TABLE documents ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
}

interface DocumentRow {
  data: string;
  revision: number;
  updated_at: string;
}

const loadDocument = database.prepare('SELECT data, revision, updated_at FROM documents WHERE id = ?');
const saveDocument = database.prepare(`
  INSERT INTO documents (id, data, revision, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    data = excluded.data,
    revision = excluded.revision,
    updated_at = excluded.updated_at
`);

function load(documentId: string): { data: CollaborativeDocumentState; revision: number; updatedAt: string | null } {
  const row = loadDocument.get(documentId) as unknown as DocumentRow | undefined;
  return row
    ? { data: JSON.parse(row.data) as CollaborativeDocumentState, revision: row.revision, updatedAt: row.updated_at }
    : { data: {}, revision: 0, updatedAt: null };
}

function patch(documentId: string, changes: CollaborativeDocumentState) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const current = load(documentId);
    const document = {
      data: { ...current.data, ...changes },
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    saveDocument.run(documentId, JSON.stringify(document.data), document.revision, document.updatedAt);
    database.exec('COMMIT');
    console.log(`[patch] document=${documentId} revision=${document.revision}`);
    return document;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

new CollaborativeServer({
  port,
  allowedOrigins: ['http://localhost:5173', 'http://localhost:5174'],
  persistence: { load, patch },
});

console.log(`Collaborative server started on ws://localhost:${port}`);
console.log(`Persisting documents to ${databasePath}`);
