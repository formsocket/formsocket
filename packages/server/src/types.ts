export type CollaborativeValue = string | number | boolean | null | undefined;

export interface CollaborativeFieldPayload {
  field: string;
  value: CollaborativeValue;
}

export interface CollaborativeServerPayload extends CollaborativeFieldPayload {
  documentId: string;
}

export interface CollaborativeDocumentState {
  [field: string]: CollaborativeValue;
}

export interface CollaborativeServerOptions {
  port: number;
  onSave?: (documentId: string, data: CollaborativeDocumentState) => void | Promise<void>;
}
