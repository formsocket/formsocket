import React, { useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import type { FieldValues, Path, UseFormReturn } from 'react-hook-form';

import type {
  CollaborativeFieldPayload,
  CollaborativeProviderProps,
  CollaborativeServerPayload,
  CollaborativeFieldName,
} from './types';

export * from './types';

interface RegisteredFieldRef<TFieldValues extends FieldValues> {
  elementRef: React.MutableRefObject<HTMLElement | null>;
  focusedRef: React.MutableRefObject<boolean>;
}

interface CollaborativeContextValue<TFieldValues extends FieldValues> {
  form: UseFormReturn<TFieldValues>;
  socketRef: React.MutableRefObject<WebSocket | null>;
  registerField: (field: string, ref: React.MutableRefObject<HTMLElement | null>, focusedRef: React.MutableRefObject<boolean>) => void;
  unregisterField: (field: string) => void;
  sendValue: (field: string, value: unknown) => void;
}

const CollaborativeContext = React.createContext<CollaborativeContextValue<any> | null>(null);

export function CollaborativeProvider<TFieldValues extends FieldValues>({
  url,
  form,
  children,
}: CollaborativeProviderProps<TFieldValues>): JSX.Element {
  const socketRef = useRef<WebSocket | null>(null);
  const fieldRefsRef = useRef<Record<string, RegisteredFieldRef<TFieldValues>>>({});

  const registerField = useCallback(
    (field: string, elementRef: React.MutableRefObject<HTMLElement | null>, focusedRef: React.MutableRefObject<boolean>) => {
      fieldRefsRef.current[field] = { elementRef, focusedRef };
    },
    [],
  );

  const unregisterField = useCallback((field: string) => {
    delete fieldRefsRef.current[field];
  }, []);

  const sendValue = useCallback((field: string, value: unknown) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(JSON.stringify({ field, value }));
  }, []);

  useEffect(() => {
    const socket = new WebSocket(url);
    socketRef.current = socket;

    socket.onmessage = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as Partial<CollaborativeServerPayload>;
        if (!payload.field || typeof payload.field !== 'string') {
          return;
        }

        const field = fieldRefsRef.current[payload.field];
        if (
          field &&
          field.focusedRef.current &&
          field.elementRef.current &&
          document.activeElement === field.elementRef.current
        ) {
          return;
        }

        form.setValue(payload.field as Path<TFieldValues>, payload.value as never, {
          shouldDirty: true,
        });
      } catch {
        // Ignore malformed remote payloads.
      }
    };

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [form, url]);

  const value = useMemo<CollaborativeContextValue<TFieldValues>>(
    () => ({
      form,
      socketRef,
      registerField,
      unregisterField,
      sendValue,
    }),
    [form, registerField, sendValue, unregisterField],
  );

  return (
    <CollaborativeContext.Provider value={value as CollaborativeContextValue<any>}>
      {children}
    </CollaborativeContext.Provider>
  );
}

export function useCollaborativeField<TFieldValues extends FieldValues, TName extends CollaborativeFieldName<TFieldValues>>(
  name: TName,
): {
  name: string;
  value: TFieldValues[TName];
  ref: (node: HTMLInputElement | HTMLTextAreaElement | null) => void;
  onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  onFocus: () => void;
  onBlur: () => void;
} {
  const context = useContext(CollaborativeContext) as CollaborativeContextValue<TFieldValues> | null;

  if (!context) {
    throw new Error('useCollaborativeField must be used within a CollaborativeProvider');
  }

  const fieldName = String(name);
  const elementRef = useRef<HTMLElement | null>(null);
  const focusedRef = useRef(false);
  const value = context.form.watch(name as Path<TFieldValues>) as TFieldValues[TName];

  const syncFocusState = useCallback(() => {
    focusedRef.current = document.activeElement === elementRef.current;
  }, []);

  useEffect(() => {
    context.registerField(fieldName, elementRef, focusedRef);
    syncFocusState();

    return () => {
      context.unregisterField(fieldName);
    };
  }, [context, fieldName, syncFocusState]);

  const onChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const nextValue = event.target.value;
      context.form.setValue(name as Path<TFieldValues>, nextValue as never, { shouldDirty: true });
      context.sendValue(fieldName, nextValue);
      syncFocusState();
    },
    [context, fieldName, name, syncFocusState],
  );

  const onFocus = useCallback(() => {
    focusedRef.current = true;
  }, []);

  const onBlur = useCallback(() => {
    focusedRef.current = false;
  }, []);

  const setRef = useCallback(
    (node: HTMLInputElement | HTMLTextAreaElement | null) => {
      elementRef.current = node;
      syncFocusState();
    },
    [syncFocusState],
  );

  return {
    name: fieldName,
    value,
    ref: setRef,
    onChange,
    onFocus,
    onBlur,
  };
}

export function useCollaborativeContext<TFieldValues extends FieldValues>(): CollaborativeContextValue<TFieldValues> {
  const context = useContext(CollaborativeContext) as CollaborativeContextValue<TFieldValues> | null;
  if (!context) {
    throw new Error('useCollaborativeContext must be used within a CollaborativeProvider');
  }
  return context;
}
