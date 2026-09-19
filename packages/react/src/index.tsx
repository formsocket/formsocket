import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { FieldValues, Path, UseFormReturn } from 'react-hook-form';

import type {
  CollaborativeDocumentResponse,
  CollaborativeDocumentState,
  CollaborativeFieldPresence,
  CollaborativeFieldName,
  CollaborativeProviderProps,
  CollaborativeStatus,
  CollaborativeUser,
} from './types';

export * from './types';

interface RegisteredFieldRef {
  elementRef: React.MutableRefObject<HTMLElement | null>;
  focusedRef: React.MutableRefObject<boolean>;
}

interface CollaborativeContextValue<TFieldValues extends FieldValues> {
  form: UseFormReturn<TFieldValues>;
  socketRef: React.MutableRefObject<WebSocket | null>;
  user: CollaborativeUser;
  presence: CollaborativeFieldPresence[];
  registerField: (field: string, ref: React.MutableRefObject<HTMLElement | null>, focusedRef: React.MutableRefObject<boolean>) => void;
  unregisterField: (field: string) => void;
  sendValue: (field: string, value: unknown) => void;
  sendPresence: (field: string | null, selection?: CollaborativeSelection) => void;
  status: CollaborativeStatus;
}

interface CollaborativeSelection {
  selectionStart: number | null;
  selectionEnd: number | null;
}

const userColors = ['#c4513e', '#2b7a4b', '#2e6da4', '#9a641c', '#7a4aa0', '#0f766e'];

function createClientId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `user-${Math.random().toString(36).slice(2, 10)}`;
}

function colorForUser(id: string): string {
  let hash = 0;
  for (const character of id) {
    hash = (hash + character.charCodeAt(0)) % userColors.length;
  }
  return userColors[hash];
}

function getSelection(element: HTMLInputElement | HTMLTextAreaElement | null): CollaborativeSelection {
  try {
    return {
      selectionStart: element?.selectionStart ?? null,
      selectionEnd: element?.selectionEnd ?? null,
    };
  } catch {
    return { selectionStart: null, selectionEnd: null };
  }
}

const CollaborativeContext = React.createContext<CollaborativeContextValue<any> | null>(null);

export function CollaborativeProvider<TFieldValues extends FieldValues>({
  url,
  persistenceUrl,
  autosaveMs = 1000,
  user,
  form,
  children,
}: CollaborativeProviderProps<TFieldValues>): JSX.Element {
  const socketRef = useRef<WebSocket | null>(null);
  const clientIdRef = useRef(createClientId());
  const clientNameRef = useRef(`User ${clientIdRef.current.slice(0, 4)}`);
  const fieldRefsRef = useRef<Record<string, RegisteredFieldRef>>({});
  const pendingChangesRef = useRef<CollaborativeDocumentState>({});
  const dirtyFieldsRef = useRef(new Set<string>());
  const bufferedUpdatesRef = useRef<Array<{ field: string; value: unknown }>>([]);
  const hydratedRef = useRef(false);
  const savingRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttemptRef = useRef(0);
  const flushRef = useRef<() => void>(() => undefined);
  const collaborativeUser = useMemo<CollaborativeUser>(() => {
    const id = user?.id ?? clientIdRef.current;
    return {
      id,
      name: user?.name ?? clientNameRef.current,
      color: user?.color ?? colorForUser(id),
    };
  }, [user?.color, user?.id, user?.name]);
  const [presence, setPresence] = useState<CollaborativeFieldPresence[]>([]);
  const [status, setStatus] = useState<CollaborativeStatus>({
    connection: 'connecting',
    save: 'loading',
    revision: 0,
    lastSavedAt: null,
    error: null,
  });

  const registerField = useCallback(
    (field: string, elementRef: React.MutableRefObject<HTMLElement | null>, focusedRef: React.MutableRefObject<boolean>) => {
      fieldRefsRef.current[field] = { elementRef, focusedRef };
    },
    [],
  );

  const isFieldLocked = useCallback((field: string) => (
    presence.some((entry) => entry.field === field && entry.user.id !== collaborativeUser.id)
  ), [collaborativeUser.id, presence]);

  const unregisterField = useCallback((field: string) => {
    delete fieldRefsRef.current[field];
  }, []);

  const applyRemoteData = useCallback((data: CollaborativeDocumentState) => {
    for (const [fieldName, value] of Object.entries(data)) {
      const field = fieldRefsRef.current[fieldName];
      const isFocused = field?.focusedRef.current
        && field.elementRef.current
        && document.activeElement === field.elementRef.current;
      if (!isFocused && !dirtyFieldsRef.current.has(fieldName)) {
        form.setValue(fieldName as Path<TFieldValues>, value as never);
      }
    }
  }, [form]);

  const scheduleSave = useCallback((delay: number) => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(() => flushRef.current(), delay);
  }, []);

  const flushPendingChanges = useCallback(async () => {
    if (savingRef.current) {
      return;
    }

    const changes = pendingChangesRef.current;
    if (Object.keys(changes).length === 0) {
      return;
    }

    pendingChangesRef.current = {};
    savingRef.current = true;

    try {
      const response = await fetch(persistenceUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes }),
        keepalive: true,
      });
      if (!response.ok) {
        throw new Error(`Autosave failed with HTTP ${response.status}`);
      }

      const document = await response.json() as CollaborativeDocumentResponse & { type?: string };
      retryAttemptRef.current = 0;
      for (const [field, value] of Object.entries(changes)) {
        if (pendingChangesRef.current[field] === undefined && form.getValues(field as Path<TFieldValues>) === value) {
          dirtyFieldsRef.current.delete(field);
        }
      }
      applyRemoteData(document.data);

      const hasPendingChanges = Object.keys(pendingChangesRef.current).length > 0;
      setStatus((current) => ({
        ...current,
        save: hasPendingChanges ? 'saving' : 'saved',
        revision: document.revision,
        lastSavedAt: document.updatedAt,
        error: null,
      }));
    } catch (error) {
      pendingChangesRef.current = { ...changes, ...pendingChangesRef.current };
      retryAttemptRef.current += 1;
      const retryDelay = Math.min(1000 * (2 ** (retryAttemptRef.current - 1)), 10_000);
      setStatus((current) => ({
        ...current,
        save: 'error',
        error: error instanceof Error ? error.message : 'Autosave failed',
      }));
      scheduleSave(retryDelay);
    } finally {
      savingRef.current = false;
      if (Object.keys(pendingChangesRef.current).length > 0 && retryAttemptRef.current === 0) {
        scheduleSave(0);
      }
    }
  }, [applyRemoteData, form, persistenceUrl, scheduleSave]);

  flushRef.current = () => {
    void flushPendingChanges();
  };

  const sendValue = useCallback((field: string, value: unknown) => {
    if (isFieldLocked(field)) {
      return;
    }

    pendingChangesRef.current[field] = value as CollaborativeDocumentState[string];
    dirtyFieldsRef.current.add(field);
    setStatus((current) => ({ ...current, save: 'saving', error: null }));
    scheduleSave(autosaveMs);

    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'update', field, value }));
    }
  }, [autosaveMs, isFieldLocked, scheduleSave]);

  const sendPresence = useCallback((field: string | null, selection?: CollaborativeSelection) => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(JSON.stringify({
      type: 'presence',
      field,
      user: collaborativeUser,
      selectionStart: selection?.selectionStart ?? null,
      selectionEnd: selection?.selectionEnd ?? null,
    }));
  }, [collaborativeUser]);

  useEffect(() => {
    const socket = new WebSocket(url);
    let disposed = false;
    let loadStarted = false;
    socketRef.current = socket;
    hydratedRef.current = false;
    bufferedUpdatesRef.current = [];
    setPresence([]);
    setStatus((current) => ({ ...current, connection: 'connecting', save: 'loading', error: null }));

    const loadDocument = async () => {
      if (loadStarted) {
        return;
      }
      loadStarted = true;

      try {
        const response = await fetch(persistenceUrl, { headers: { Accept: 'application/json' } });
        if (!response.ok) {
          throw new Error(`Document load failed with HTTP ${response.status}`);
        }

        const document = await response.json() as CollaborativeDocumentResponse;
        if (disposed) {
          return;
        }

        form.reset({ ...form.getValues(), ...document.data } as TFieldValues);
        hydratedRef.current = true;
        for (const update of bufferedUpdatesRef.current) {
          form.setValue(update.field as Path<TFieldValues>, update.value as never, { shouldDirty: true });
        }
        bufferedUpdatesRef.current = [];
        setStatus((current) => ({
          ...current,
          save: 'saved',
          revision: document.revision,
          lastSavedAt: document.updatedAt,
          error: null,
        }));
      } catch (error) {
        if (!disposed) {
          setStatus((current) => ({
            ...current,
            save: 'error',
            error: error instanceof Error ? error.message : 'Document load failed',
          }));
        }
      }
    };

    socket.onopen = () => {
      if (disposed) {
        socket.close();
        return;
      }
      setStatus((current) => ({ ...current, connection: 'connected' }));
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as Record<string, unknown>;
        if (payload.type === 'ready') {
          return;
        }

        if (payload.type === 'presence-state' && Array.isArray(payload.presence)) {
          setPresence(payload.presence as CollaborativeFieldPresence[]);
          return;
        }

        if (payload.type === 'persisted' && payload.data && typeof payload.data === 'object') {
          applyRemoteData(payload.data as CollaborativeDocumentState);
          setStatus((current) => ({
            ...current,
            revision: typeof payload.revision === 'number' ? payload.revision : current.revision,
            lastSavedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : current.lastSavedAt,
          }));
          return;
        }

        if (payload.type !== 'update' || typeof payload.field !== 'string') {
          return;
        }

        if (!hydratedRef.current) {
          bufferedUpdatesRef.current.push({ field: payload.field, value: payload.value });
          return;
        }

        const field = fieldRefsRef.current[payload.field];
        const isFocused = field?.focusedRef.current
          && field.elementRef.current
          && document.activeElement === field.elementRef.current;
        if (!isFocused && !dirtyFieldsRef.current.has(payload.field)) {
          form.setValue(payload.field as Path<TFieldValues>, payload.value as never, { shouldDirty: true });
        }
      } catch {
        // Ignore malformed remote payloads.
      }
    };

    socket.onclose = () => {
      if (!disposed) {
        setStatus((current) => ({ ...current, connection: 'disconnected' }));
      }
    };

    socket.onerror = () => {
      if (!disposed) {
        setStatus((current) => ({ ...current, connection: 'disconnected' }));
      }
    };

    void loadDocument();

    return () => {
      disposed = true;
      if (socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
      socketRef.current = null;
    };
  }, [applyRemoteData, form, persistenceUrl, url]);

  useEffect(() => {
    const flushOnPageHide = () => {
      sendPresence(null);
      flushRef.current();
    };
    window.addEventListener('pagehide', flushOnPageHide);
    return () => {
      window.removeEventListener('pagehide', flushOnPageHide);
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, [sendPresence]);

  const value = useMemo<CollaborativeContextValue<TFieldValues>>(
    () => ({ form, socketRef, user: collaborativeUser, presence, registerField, unregisterField, sendValue, sendPresence, status }),
    [collaborativeUser, form, presence, registerField, sendPresence, sendValue, status, unregisterField],
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
  onSelect: (event: React.SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  onKeyUp: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  disabled: boolean;
  lockedBy: CollaborativeUser | null;
  presence: CollaborativeFieldPresence[];
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
  const fieldPresence = context.presence.filter((entry) => entry.field === fieldName && entry.user.id !== context.user.id);
  const lockedBy = fieldPresence[0]?.user ?? null;
  const disabled = Boolean(lockedBy);

  const syncFocusState = useCallback(() => {
    focusedRef.current = document.activeElement === elementRef.current;
  }, []);

  useEffect(() => {
    context.registerField(fieldName, elementRef, focusedRef);
    syncFocusState();
    return () => context.unregisterField(fieldName);
  }, [context, fieldName, syncFocusState]);

  const onChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (disabled) {
        return;
      }

      const nextValue = event.target.value;
      context.form.setValue(name as Path<TFieldValues>, nextValue as never, { shouldDirty: true });
      context.sendValue(fieldName, nextValue);
      context.sendPresence(fieldName, getSelection(event.target));
      syncFocusState();
    },
    [context, disabled, fieldName, name, syncFocusState],
  );

  const onFocus = useCallback((event?: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (disabled) {
      event?.currentTarget.blur();
      return;
    }

    focusedRef.current = true;
    context.sendPresence(fieldName, getSelection(event?.currentTarget ?? elementRef.current as HTMLInputElement | HTMLTextAreaElement | null));
  }, [context, disabled, fieldName]);

  const onBlur = useCallback(() => {
    focusedRef.current = false;
    context.sendPresence(null);
  }, [context]);

  const onSelect = useCallback((event: React.SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (!disabled) {
      context.sendPresence(fieldName, getSelection(event.currentTarget));
    }
  }, [context, disabled, fieldName]);

  const onKeyUp = useCallback((event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (!disabled) {
      context.sendPresence(fieldName, getSelection(event.currentTarget));
    }
  }, [context, disabled, fieldName]);

  useEffect(() => {
    if (disabled && document.activeElement === elementRef.current) {
      elementRef.current?.blur();
    }
  }, [disabled]);

  const setRef = useCallback((node: HTMLInputElement | HTMLTextAreaElement | null) => {
    elementRef.current = node;
    syncFocusState();
  }, [syncFocusState]);

  return { name: fieldName, value, ref: setRef, onChange, onSelect, onKeyUp, disabled, lockedBy, presence: fieldPresence, onFocus, onBlur };
}

export function useCollaborativeContext<TFieldValues extends FieldValues>(): CollaborativeContextValue<TFieldValues> {
  const context = useContext(CollaborativeContext) as CollaborativeContextValue<TFieldValues> | null;
  if (!context) {
    throw new Error('useCollaborativeContext must be used within a CollaborativeProvider');
  }
  return context;
}

export function useCollaborativeStatus(): CollaborativeStatus {
  return useCollaborativeContext().status;
}
