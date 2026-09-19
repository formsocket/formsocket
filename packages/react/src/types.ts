import type { FieldValues, Path, UseFormReturn } from 'react-hook-form';

export type CollaborativeValue = string | number | boolean | null | undefined;

export interface CollaborativeDocumentState {
  [field: string]: CollaborativeValue;
}

export interface CollaborativeFieldPayload {
  type: 'update';
  field: string;
  value: CollaborativeValue;
}

export interface CollaborativeUser {
  id: string;
  name: string;
  color?: string;
}

export interface CollaborativeFieldPresence {
  field: string;
  user: CollaborativeUser;
  selectionStart: number | null;
  selectionEnd: number | null;
}

export interface CollaborativePresencePayload {
  type: 'presence';
  field: string | null;
  user: CollaborativeUser;
  selectionStart?: number | null;
  selectionEnd?: number | null;
}

export interface CollaborativePresenceStatePayload {
  type: 'presence-state';
  documentId: string;
  presence: CollaborativeFieldPresence[];
}

export interface CollaborativeServerPayload extends CollaborativeFieldPayload {
  documentId: string;
}

export interface CollaborativeReadyPayload {
  type: 'ready';
  documentId: string;
}

export interface CollaborativePersistedPayload {
  type: 'persisted';
  documentId: string;
  data: CollaborativeDocumentState;
  revision: number;
  updatedAt: string;
}

export type CollaborativeServerMessage =
  | CollaborativeServerPayload
  | CollaborativeReadyPayload
  | CollaborativePersistedPayload
  | CollaborativePresenceStatePayload;

export interface CollaborativeDocumentResponse {
  documentId: string;
  data: CollaborativeDocumentState;
  revision: number;
  updatedAt: string | null;
}

export interface CollaborativeStatus {
  connection: 'connecting' | 'connected' | 'disconnected';
  save: 'loading' | 'saved' | 'saving' | 'error';
  revision: number;
  lastSavedAt: string | null;
  error: string | null;
}

export interface CollaborativeProviderProps<TFieldValues extends FieldValues> {
  url: string;
  persistenceUrl: string;
  autosaveMs?: number;
  user?: Partial<CollaborativeUser>;
  form: UseFormReturn<TFieldValues>;
  children: React.ReactNode;
}

export type CollaborativeFieldName<TFieldValues extends FieldValues> = Path<TFieldValues> & string;
