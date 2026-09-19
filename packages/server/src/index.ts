import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

import type {
  CollaborativeDocumentState,
  CollaborativeFieldPayload,
  CollaborativeFieldPresence,
  CollaborativePresencePayload,
  CollaborativeServerMessage,
  CollaborativeServerOptions,
  CollaborativeServerPayload,
  CollaborativeUser,
  PersistedDocument,
} from './types';

export * from './types';

export class CollaborativeServer {
  private readonly server: WebSocketServer;
  private readonly httpServer: Server;
  private readonly rooms = new Map<string, Set<WebSocket>>();
  private readonly presence = new Map<string, Map<WebSocket, CollaborativeFieldPresence>>();
  private readonly persistence?: CollaborativeServerOptions['persistence'];
  private readonly apiPath: string;
  private readonly allowedOrigins: Set<string>;
  private readonly maxBodyBytes: number;

  constructor(options: CollaborativeServerOptions) {
    const {
      port,
      persistence,
      apiPath = '/api/documents',
      allowedOrigins = [],
      maxBodyBytes = 1_000_000,
    } = options;

    this.persistence = persistence;
    this.apiPath = apiPath.replace(/\/$/, '');
    this.allowedOrigins = new Set(allowedOrigins);
    this.maxBodyBytes = maxBodyBytes;

    this.httpServer = createServer((request, response) => {
      void this.handleHttpRequest(request, response);
    });
    this.server = new WebSocketServer({ noServer: true });

    this.httpServer.listen(port, () => {
      console.log(`Collaborative server listening on http://localhost:${port}`);
    });

    this.httpServer.on('upgrade', (request: IncomingMessage, socket, head) => {
      const documentId = this.getWebSocketDocumentId(request);
      if (!documentId) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      const room = this.ensureRoom(documentId);
      this.server.handleUpgrade(request, socket, head, (webSocket) => {
        room.add(webSocket);
        this.server.emit('connection', webSocket, request);
      });
    });

    this.server.on('connection', (socket: WebSocket, request: IncomingMessage) => {
      const documentId = this.getWebSocketDocumentId(request);
      if (!documentId) {
        socket.close();
        return;
      }

      this.send(socket, { type: 'ready', documentId });
      this.sendPresenceState(documentId, socket);

      socket.on('message', (raw: Buffer) => {
        this.handleRealtimeMessage(documentId, socket, raw);
      });

      socket.on('close', () => {
        this.closeClient(documentId, socket);
      });
    });
  }

  whenReady(): Promise<void> {
    if (this.httpServer.listening) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      this.httpServer.once('listening', resolve);
      this.httpServer.once('error', reject);
    });
  }

  get port(): number {
    const address = this.httpServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Collaborative server is not listening on a TCP port');
    }
    return address.port;
  }

  async close(): Promise<void> {
    for (const client of this.server.clients) {
      client.terminate();
    }

    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
    await new Promise<void>((resolve, reject) => {
      this.httpServer.close((error) => error ? reject(error) : resolve());
    });
  }

  private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.setCorsHeaders(request, response);
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end();
      return;
    }

    const documentId = this.getApiDocumentId(request);
    if (!documentId || !this.persistence) {
      this.sendJson(response, 404, { error: 'Not found' });
      return;
    }

    try {
      if (request.method === 'GET') {
        const document = await this.persistence.load(documentId);
        this.sendJson(response, 200, { documentId, ...document });
        return;
      }

      if (request.method === 'PATCH') {
        const body = await this.readJsonBody(request);
        const changes = this.parseChanges(body);
        const document = await this.persistence.patch(documentId, changes);
        const message = this.toPersistedMessage(documentId, document);
        this.broadcast(documentId, message);
        this.sendJson(response, 200, message);
        return;
      }

      response.setHeader('Allow', 'GET, PATCH, OPTIONS');
      this.sendJson(response, 405, { error: 'Method not allowed' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Request failed';
      const clientErrors = ['Invalid JSON body', 'Body must be an object containing changes', 'changes must be an object', 'changes must contain supported field values'];
      const statusCode = message === 'Request body is too large' ? 413 : clientErrors.includes(message) ? 400 : 500;
      this.sendJson(response, statusCode, { error: message });
    }
  }

  private handleRealtimeMessage(documentId: string, sender: WebSocket, raw: Buffer): void {
    let payload: Partial<CollaborativeFieldPayload | CollaborativePresencePayload>;

    try {
      payload = JSON.parse(raw.toString()) as Partial<CollaborativeFieldPayload | CollaborativePresencePayload>;
    } catch {
      return;
    }

    if (payload.type === 'presence') {
      this.handlePresenceMessage(documentId, sender, payload);
      return;
    }

    if (
      payload.type !== 'update'
      || !payload.field
      || typeof payload.field !== 'string'
      || !this.isCollaborativeValue(payload.value)
    ) {
      return;
    }

    const message: CollaborativeServerPayload = {
      type: 'update',
      documentId,
      field: payload.field,
      value: payload.value,
    };

    const room = this.rooms.get(documentId);
    if (!room) {
      return;
    }

    for (const client of room) {
      if (client !== sender && client.readyState === WebSocket.OPEN) {
        this.send(client, message);
      }
    }
  }

  private handlePresenceMessage(documentId: string, sender: WebSocket, payload: Partial<CollaborativePresencePayload>): void {
    if (!payload.user || !this.isCollaborativeUser(payload.user)) {
      return;
    }

    if (payload.field === null) {
      const roomPresence = this.presence.get(documentId);
      roomPresence?.delete(sender);
      this.broadcastPresenceState(documentId);
      return;
    }

    if (!payload.field || typeof payload.field !== 'string') {
      return;
    }

    const roomPresence = this.ensurePresence(documentId);
    roomPresence.set(sender, {
      field: payload.field,
      user: payload.user,
      selectionStart: this.toSelectionIndex(payload.selectionStart),
      selectionEnd: this.toSelectionIndex(payload.selectionEnd),
    });
    this.broadcastPresenceState(documentId);
  }

  private getWebSocketDocumentId(request: IncomingMessage): string | null {
    const pathname = request.url ? new URL(request.url, 'http://localhost').pathname : '/';
    const match = pathname.match(/^\/form\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  private getApiDocumentId(request: IncomingMessage): string | null {
    const pathname = request.url ? new URL(request.url, 'http://localhost').pathname : '/';
    const prefix = `${this.apiPath}/`;
    if (!pathname.startsWith(prefix) || pathname.length === prefix.length) {
      return null;
    }

    const encodedDocumentId = pathname.slice(prefix.length);
    return encodedDocumentId.includes('/') ? null : decodeURIComponent(encodedDocumentId);
  }

  private readJsonBody(request: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;

      request.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > this.maxBodyBytes) {
          reject(new Error('Request body is too large'));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });

      request.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Error('Invalid JSON body'));
        }
      });
      request.on('error', reject);
    });
  }

  private parseChanges(body: unknown): CollaborativeDocumentState {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('Body must be an object containing changes');
    }

    const changes = (body as { changes?: unknown }).changes;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      throw new Error('changes must be an object');
    }

    const entries = Object.entries(changes);
    if (entries.length === 0 || entries.some(([field, value]) => !field || !this.isCollaborativeValue(value))) {
      throw new Error('changes must contain supported field values');
    }

    return Object.fromEntries(entries) as CollaborativeDocumentState;
  }

  private isCollaborativeValue(value: unknown): value is CollaborativeDocumentState[string] {
    return value == null || ['string', 'number', 'boolean'].includes(typeof value);
  }

  private isCollaborativeUser(user: unknown): user is CollaborativeUser {
    return Boolean(
      user
      && typeof user === 'object'
      && !Array.isArray(user)
      && typeof (user as CollaborativeUser).id === 'string'
      && (user as CollaborativeUser).id.length > 0
      && typeof (user as CollaborativeUser).name === 'string'
      && (user as CollaborativeUser).name.length > 0
      && ((user as CollaborativeUser).color === undefined || typeof (user as CollaborativeUser).color === 'string'),
    );
  }

  private toSelectionIndex(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
  }

  private toPersistedMessage(documentId: string, document: PersistedDocument): CollaborativeServerMessage {
    return {
      type: 'persisted',
      documentId,
      data: document.data,
      revision: document.revision,
      updatedAt: document.updatedAt ?? new Date().toISOString(),
    };
  }

  private setCorsHeaders(request: IncomingMessage, response: ServerResponse): void {
    const origin = request.headers.origin;
    if (origin && this.allowedOrigins.has(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
  }

  private sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
    response.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify(body));
  }

  private ensureRoom(documentId: string): Set<WebSocket> {
    let room = this.rooms.get(documentId);
    if (!room) {
      room = new Set();
      this.rooms.set(documentId, room);
    }
    return room;
  }

  private ensurePresence(documentId: string): Map<WebSocket, CollaborativeFieldPresence> {
    let roomPresence = this.presence.get(documentId);
    if (!roomPresence) {
      roomPresence = new Map();
      this.presence.set(documentId, roomPresence);
    }
    return roomPresence;
  }

  private getPresenceState(documentId: string): CollaborativeFieldPresence[] {
    return [...(this.presence.get(documentId)?.values() ?? [])];
  }

  private broadcast(documentId: string, message: CollaborativeServerMessage): void {
    const room = this.rooms.get(documentId);
    if (!room) {
      return;
    }

    for (const client of room) {
      if (client.readyState === WebSocket.OPEN) {
        this.send(client, message);
      }
    }
  }

  private sendPresenceState(documentId: string, socket: WebSocket): void {
    this.send(socket, {
      type: 'presence-state',
      documentId,
      presence: this.getPresenceState(documentId),
    });
  }

  private broadcastPresenceState(documentId: string): void {
    this.broadcast(documentId, {
      type: 'presence-state',
      documentId,
      presence: this.getPresenceState(documentId),
    });
  }

  private send(socket: WebSocket, message: CollaborativeServerMessage): void {
    socket.send(JSON.stringify(message));
  }

  private closeClient(documentId: string, socket: WebSocket): void {
    const room = this.rooms.get(documentId);
    if (!room) {
      return;
    }

    room.delete(socket);
    this.presence.get(documentId)?.delete(socket);
    if (room.size === 0) {
      this.rooms.delete(documentId);
      this.presence.delete(documentId);
      return;
    }

    this.broadcastPresenceState(documentId);
  }
}
