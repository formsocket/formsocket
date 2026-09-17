import { createServer, IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { URL } from 'node:url';

import type {
  CollaborativeDocumentState,
  CollaborativeFieldPayload,
  CollaborativeServerOptions,
  CollaborativeServerPayload,
} from './types';

export * from './types';

export class CollaborativeServer {
  private readonly server: WebSocketServer;
  private readonly rooms = new Map<string, Set<WebSocket>>();
  private readonly documents = new Map<string, CollaborativeDocumentState>();
  private readonly saveTimers = new Map<string, NodeJS.Timeout>();
  private readonly onSave?: (documentId: string, data: CollaborativeDocumentState) => void | Promise<void>;

  constructor(options: CollaborativeServerOptions) {
    const { port, onSave } = options;
    this.onSave = onSave;

    const httpServer = createServer();
    this.server = new WebSocketServer({ server: httpServer });

    httpServer.listen(port, () => {
      console.log(`Collaborative server listening on ws://localhost:${port}`);
    });

    httpServer.on('upgrade', (request: IncomingMessage, socket, head) => {
      const pathname = request.url ? new URL(request.url, 'http://localhost').pathname : '/';
      const match = pathname.match(/^\/form\/([^/]+)$/);

      if (!match) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      const documentId = decodeURIComponent(match[1]);
      const room = this.ensureRoom(documentId);

      this.server.handleUpgrade(request, socket, head, (ws) => {
        room.add(ws);
        this.server.emit('connection', ws, request);
      });
    });

    this.server.on('connection', (socket: WebSocket, request: IncomingMessage) => {
      const pathname = request.url ? new URL(request.url, 'http://localhost').pathname : '/';
      const match = pathname.match(/^\/form\/([^/]+)$/);

      if (!match) {
        socket.close();
        return;
      }

      const documentId = decodeURIComponent(match[1]);
      socket.on('message', (raw: Buffer) => {
        this.handleMessage(documentId, socket, raw);
      });

      socket.on('close', () => {
        this.closeClient(documentId, socket);
      });
    });
  }

  private ensureRoom(documentId: string): Set<WebSocket> {
    let room = this.rooms.get(documentId);
    if (!room) {
      room = new Set();
      this.rooms.set(documentId, room);
    }
    return room;
  }

  private handleMessage(documentId: string, sender: WebSocket, raw: Buffer): void {
    let payload: Partial<CollaborativeFieldPayload>;

    try {
      payload = JSON.parse(raw.toString()) as Partial<CollaborativeFieldPayload>;
    } catch {
      return;
    }

    if (!payload.field || typeof payload.field !== 'string') {
      return;
    }

    const room = this.rooms.get(documentId);
    if (!room) {
      return;
    }

    const value = payload.value;
    const currentDocument = this.documents.get(documentId) ?? {};
    currentDocument[payload.field] = value;
    this.documents.set(documentId, currentDocument);

    const message: CollaborativeServerPayload = {
      documentId,
      field: payload.field,
      value,
    };

    for (const client of room) {
      if (client !== sender && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
      }
    }

    this.scheduleSave(documentId, currentDocument);
  }

  private scheduleSave(documentId: string, data: CollaborativeDocumentState): void {
    const existingTimer = this.saveTimers.get(documentId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.saveTimers.delete(documentId);
      void this.onSave?.(documentId, { ...data });
    }, 5000);

    this.saveTimers.set(documentId, timer);
  }

  private closeClient(documentId: string, socket: WebSocket): void {
    const room = this.rooms.get(documentId);
    if (!room) {
      return;
    }

    room.delete(socket);

    if (room.size === 0) {
      this.rooms.delete(documentId);
      this.documents.delete(documentId);

      const pendingSave = this.saveTimers.get(documentId);
      if (pendingSave) {
        clearTimeout(pendingSave);
        this.saveTimers.delete(documentId);
      }
    }
  }
}
