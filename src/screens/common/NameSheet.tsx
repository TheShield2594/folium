import { useState, type ReactNode } from 'react';
import { findNameClash, nextFreeName } from '../../domain/drafts';
import { Button, Field, Sheet, TextInput, toast } from '../../ui/controls';
import { Icon } from '../../ui/Icon';

interface Named {
  id: string;
  name: string;
}

/**
 * Name (or rename) a draft or packet. A name that matches another one, ignoring case
 * and spacing, offers "Save as … (2)" and, when allowed, updating the one that's there.
 */
export function NameSheet<T extends Named>(props: {
  title: string;
  noun: 'draft' | 'packet';
  initial: string;
  existing: T[];
  /** The item being renamed, which doesn't clash with itself. */
  exceptId?: string;
  saveLabel?: string;
  onSave: (name: string) => Promise<void>;
  /** Offered when the name clashes with an item this person may overwrite. */
  replace?: { label: string; allowed: (clash: T) => boolean; run: (clash: T) => Promise<void> };
  onClose: () => void;
  children?: ReactNode;
}) {
  const { noun, existing, exceptId, onClose } = props;
  const [name, setName] = useState(props.initial);
  const [busy, setBusy] = useState<string>();
  const [clash, setClash] = useState<T>();
  const alt = nextFreeName(name, existing.filter((x) => x.id !== exceptId).map((x) => x.name));

  async function run(key: string, fn: () => Promise<void>) {
    if (busy) return; // one save at a time
    setBusy(key);
    try {
      await fn();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Could not save the ${noun}`);
      setBusy(undefined);
    }
  }

  function submit() {
    if (busy) return;
    const c = findNameClash(name, existing, exceptId);
    if (c) return setClash(c);
    void run('save', () => props.onSave(name.trim().replace(/\s+/g, ' ')));
  }

  return (
    <Sheet
      title={props.title}
      onClose={onClose}
      footer={
        clash ? (
          <>
            <Button variant="gray" disabled={!!busy} onClick={() => setClash(undefined)}>
              Change name
            </Button>
            {props.replace?.allowed(clash) && (
              <Button variant="bordered" disabled={!!busy} busy={busy === 'replace'} onClick={() => run('replace', () => props.replace!.run(clash))}>
                {props.replace.label}
              </Button>
            )}
            <Button variant="filled" disabled={!!busy} busy={busy === 'save'} onClick={() => run('save', () => props.onSave(alt))}>
              Save as “{alt}”
            </Button>
          </>
        ) : (
          <>
            <Button variant="gray" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="filled" disabled={!name.trim()} busy={busy === 'save'} onClick={submit}>
              {props.saveLabel ?? 'Save'}
            </Button>
          </>
        )
      }
    >
      <form
        className="stack-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && !clash) submit();
        }}
      >
        <Field label="Name" htmlFor="name-sheet">
          <TextInput id="name-sheet" value={name} disabled={!!busy} onChange={(e) => (setName(e.target.value), setClash(undefined))} />
        </Field>
        {clash && (
          <div className="banner" role="alert">
            <Icon name="warning" size={16} />
            <span className="t-callout">
              There’s already a {noun} called “{clash.name}”.
            </span>
          </div>
        )}
        {props.children}
      </form>
    </Sheet>
  );
}
