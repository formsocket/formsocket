import type { FieldValues, Path, UseFormReturn } from 'react-hook-form';

export type CollaborativeValue = string | number | boolean | null | undefined;

export interface CollaborativeFieldPayload {
  field: string;
  value: CollaborativeValue;
}

export interface CollaborativeServerPayload extends CollaborativeFieldPayload {
  documentId: string;
}

export interface CollaborativeProviderProps<TFieldValues extends FieldValues> {
  url: string;
  form: UseFormReturn<TFieldValues>;
  children: React.ReactNode;
}

export type CollaborativeFieldName<TFieldValues extends FieldValues> = Path<TFieldValues> & string;
