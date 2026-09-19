import React from 'react';
import { useForm, type UseFormReturn } from 'react-hook-form';
import {
  type CollaborativeFieldPresence,
  CollaborativeProvider,
  type CollaborativeUser,
  useCollaborativeField,
  useCollaborativeStatus,
} from '@formsocket/react';

type FormValues = {
  projectName: string;
  owner: string;
  targetDate: string;
  budget: string;
  summary: string;
  risks: string;
};

const defaultValues: FormValues = {
  projectName: '',
  owner: '',
  targetDate: '',
  budget: '',
  summary: '',
  risks: '',
};

export function App(): JSX.Element {
  const form = useForm<FormValues>({ defaultValues });
  const params = new URLSearchParams(window.location.search);
  const documentId = params.get('document') ?? 'launch-brief';
  const userName = React.useMemo(() => params.get('user') ?? `Editor ${Math.floor(Math.random() * 900 + 100)}`, []);

  return (
    <CollaborativeProvider<FormValues>
      url={`ws://localhost:8080/form/${encodeURIComponent(documentId)}`}
      persistenceUrl={`http://localhost:8080/api/documents/${encodeURIComponent(documentId)}`}
      autosaveMs={1000}
      user={{ name: userName }}
      form={form}
    >
      <CollaborativeForm form={form} documentId={documentId} userName={userName} />
    </CollaborativeProvider>
  );
}

function CollaborativeForm({
  form,
  documentId,
  userName,
}: {
  form: UseFormReturn<FormValues>;
  documentId: string;
  userName: string;
}): JSX.Element {
  const status = useCollaborativeStatus();
  const projectName = useCollaborativeField<FormValues, 'projectName'>('projectName');
  const owner = useCollaborativeField<FormValues, 'owner'>('owner');
  const targetDate = useCollaborativeField<FormValues, 'targetDate'>('targetDate');
  const budget = useCollaborativeField<FormValues, 'budget'>('budget');
  const summary = useCollaborativeField<FormValues, 'summary'>('summary');
  const risks = useCollaborativeField<FormValues, 'risks'>('risks');

  const openSecondEditor = () => {
    const url = new URL(window.location.href);
    url.searchParams.set('document', documentId);
    url.searchParams.set('user', `Editor ${Math.floor(Math.random() * 900 + 100)}`);
    window.open(url.toString(), '_blank');
  };

  const saveLabel = status.save === 'loading'
    ? 'Loading...'
    : status.save === 'saving'
      ? 'Saving...'
    : status.save === 'error'
      ? 'Save failed'
      : status.lastSavedAt
        ? `Saved ${new Date(status.lastSavedAt).toLocaleTimeString()}`
        : 'Saved';

  return (
    <main className="workspace">
      <header className="topbar">
        <div>
          <p className="eyebrow">FormSocket workspace</p>
          <h1>Project brief</h1>
          <p className="current-user">Editing as {userName}</p>
        </div>
        <div className="topbar-actions">
          <span className="connection" data-state={status.connection}>
            <span className="connection-dot" />
            {status.connection}
          </span>
          <button type="button" onClick={openSecondEditor}>
            Open second editor
          </button>
        </div>
      </header>

      <section className="document-meta" aria-label="Document information">
        <span>Document</span>
        <strong>{documentId}</strong>
        <span className="save-status" data-state={status.save}>{saveLabel}</span>
      </section>

      {status.error && <p className="error-banner" role="alert">{status.error}</p>}

      <form className="brief-form" onSubmit={(event) => event.preventDefault()}>
        <section className="form-section">
          <div className="section-heading">
            <span>01</span>
            <div>
              <h2>Overview</h2>
              <p>The shared facts everyone works from.</p>
            </div>
          </div>

          <div className="field-grid">
            <label className="field field-wide">
              <FieldLabel label="Project name" lockedBy={projectName.lockedBy} />
              <input {...form.register('projectName')} {...projectName} placeholder="Q4 product launch" />
            </label>
            <label className="field">
              <FieldLabel label="Owner" lockedBy={owner.lockedBy} />
              <input {...form.register('owner')} {...owner} placeholder="Name or team" />
            </label>
            <label className="field">
              <FieldLabel label="Target date" lockedBy={targetDate.lockedBy} />
              <input {...form.register('targetDate')} {...targetDate} type="date" />
            </label>
            <label className="field">
              <FieldLabel label="Budget" lockedBy={budget.lockedBy} />
              <input {...form.register('budget')} {...budget} inputMode="decimal" placeholder="$75,000" />
            </label>
          </div>
        </section>

        <section className="form-section">
          <div className="section-heading">
            <span>02</span>
            <div>
              <h2>Working notes</h2>
              <p>Long-form fields sync independently between editors.</p>
            </div>
          </div>

          <div className="field-grid">
            <label className="field field-wide">
              <FieldLabel label="Executive summary" lockedBy={summary.lockedBy} />
              <textarea {...form.register('summary')} {...summary} rows={6} placeholder="Describe the outcome and why it matters." />
            </label>
            <label className="field field-wide">
              <FieldLabel label="Risks and dependencies" lockedBy={risks.lockedBy} />
              <textarea {...form.register('risks')} {...risks} rows={5} placeholder="Capture blockers, dependencies, and open decisions." />
            </label>
          </div>
        </section>
      </form>
    </main>
  );
}

function FieldLabel({
  label,
  lockedBy,
}: {
  label: string;
  lockedBy: CollaborativeUser | null;
}): JSX.Element {
  return (
    <span className="field-heading">
      <span>{label}</span>
      {lockedBy && (
        <span className="lock-chip" style={{ ['--presence-color' as string]: lockedBy.color ?? '#52705c' }}>
          {lockedBy.name} editing
        </span>
      )}
    </span>
  );
}

export default App;
