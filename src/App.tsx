import React from 'react';
import { useForm } from 'react-hook-form';
import { CollaborativeProvider, useCollaborativeField } from '@formsocket/react';

type FormValues = {
  title: string;
  notes: string;
};

export function App(): JSX.Element {
  const form = useForm<FormValues>({
    defaultValues: {
      title: '',
      notes: '',
    },
  });

  const titleField = useCollaborativeField('title');
  const notesField = useCollaborativeField('notes');

  return (
    <CollaborativeProvider<FormValues> url="ws://localhost:8080/form/demo-document" form={form}>
      <form style={{ display: 'grid', gap: '1rem', maxWidth: 420 }}>
        <label>
          <span>Title</span>
          <input
            {...form.register('title')}
            {...titleField}
            placeholder="Project title"
          />
        </label>

        <label>
          <span>Notes</span>
          <textarea
            {...form.register('notes')}
            {...notesField}
            rows={5}
            placeholder="Share notes with teammates"
          />
        </label>
      </form>
    </CollaborativeProvider>
  );
}

export default App;
