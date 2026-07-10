'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import { listFlows, createFlow, publishFlow, type FlowSummary, type FlowFieldInput, type FlowFieldType } from '@/lib/api';

const TYPE_LABELS: Record<FlowFieldType, string> = {
  text: 'Texte',
  email: 'Email',
  phone: 'Téléphone',
  number: 'Nombre',
  textarea: 'Zone de texte',
  date: 'Date',
};

export default function FlowsPage() {
  return <AppShell active="flows">{(session) => <FlowsInner session={session} />}</AppShell>;
}

function FlowsInner({ session }: { session: Session }) {
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { flows } = await listFlows(session.tenantId);
      setFlows(flows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chargement impossible');
    } finally {
      setLoading(false);
    }
  }, [session.tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function publish(f: FlowSummary) {
    if (!window.confirm(`Publier le formulaire « ${f.name} » ?\nUn formulaire publié ne peut plus être modifié (irréversible côté Meta). Pour changer les champs, il faudra en créer un nouveau.`)) return;
    setError(null);
    const prev = flows;
    setFlows((list) => list.map((x) => (x.id === f.id ? { ...x, status: 'PUBLISHED' } : x))); // optimiste
    try {
      await publishFlow(session.tenantId, f.id);
    } catch (err) {
      setFlows(prev);
      setError(err instanceof Error ? err.message : 'Publication impossible');
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold tracking-tight text-ink-900">Flows</h2>
        <p className="mt-1 text-sm text-ink-500">Formulaires de collecte : le client remplit dans WhatsApp, la réponse arrive dans l&apos;inbox. Attache un formulaire publié à un template via un bouton « Flow ».</p>
      </div>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <CreateFlowForm tenantId={session.tenantId} onCreated={load} />

      <div className="overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-sm">
        <div className="border-b border-ink-100 px-5 py-3 text-sm font-semibold text-ink-900">Formulaires ({flows.length})</div>
        {loading ? (
          <p className="px-5 py-6 text-sm text-ink-500">Chargement…</p>
        ) : flows.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-500">Aucun formulaire pour l&apos;instant.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-left text-xs uppercase tracking-wide text-ink-400">
                <th className="px-5 py-2 font-medium">Nom</th>
                <th className="px-5 py-2 font-medium">Champs</th>
                <th className="px-5 py-2 font-medium">Statut</th>
                <th className="px-5 py-2 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {flows.map((f) => (
                <tr key={f.id} className="border-b border-ink-50 last:border-0">
                  <td className="px-5 py-3 text-ink-800">{f.name}</td>
                  <td className="px-5 py-3 text-ink-500">{f.fields.map((x) => x.label).join(', ') || '—'}</td>
                  <td className="px-5 py-3">
                    {f.status === 'PUBLISHED' ? (
                      <span className="inline-flex items-center rounded-full bg-mint-50 px-2 py-0.5 text-xs font-medium text-mint-700">Publié</span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-gold/10 px-2 py-0.5 text-xs font-medium text-gold">Brouillon</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right">
                    {f.status === 'DRAFT' ? (
                      <button onClick={() => publish(f)} className="font-medium text-brand-600 hover:text-brand-700">Publier</button>
                    ) : (
                      <span className="text-ink-300">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

type FieldRow = FlowFieldInput;

function CreateFlowForm({ tenantId, onCreated }: { tenantId: string; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [fields, setFields] = useState<FieldRow[]>([{ label: '', type: 'text', required: true }]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const canSubmit = name.trim() !== '' && fields.length > 0 && fields.every((f) => f.label.trim() !== '');

  function setField(i: number, patch: Partial<FieldRow>) {
    setFields((list) => list.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  }
  function addField() {
    setFields((list) => [...list, { label: '', type: 'text', required: false }]);
  }
  function removeField(i: number) {
    setFields((list) => (list.length > 1 ? list.filter((_, j) => j !== i) : list));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      await createFlow(tenantId, { name: name.trim(), fields: fields.map((f) => ({ label: f.label.trim(), type: f.type, required: f.required })) });
      setMsg({ kind: 'ok', text: `Formulaire « ${name.trim()} » créé (brouillon). Publie-le pour l'utiliser.` });
      setName('');
      setFields([{ label: '', type: 'text', required: true }]);
      onCreated();
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Création impossible' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
      <div className="text-sm font-semibold text-ink-900">Créer un formulaire</div>
      <div>
        <label className="mb-1 block text-xs font-medium text-ink-600">Nom du formulaire</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full max-w-sm rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          placeholder="Demande de contact"
        />
      </div>

      <div className="space-y-2">
        <div className="text-xs font-medium text-ink-600">Champs</div>
        {fields.map((f, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <input
              value={f.label}
              onChange={(e) => setField(i, { label: e.target.value })}
              className="min-w-0 flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              placeholder="Libellé (ex. Email)"
            />
            <select
              value={f.type}
              onChange={(e) => setField(i, { type: e.target.value as FlowFieldType })}
              className="rounded-lg border border-ink-300 bg-white px-2 py-2 text-sm text-ink-800"
            >
              {(Object.keys(TYPE_LABELS) as FlowFieldType[]).map((t) => (
                <option key={t} value={t}>{TYPE_LABELS[t]}</option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-xs text-ink-600">
              <input type="checkbox" checked={f.required} onChange={(e) => setField(i, { required: e.target.checked })} />
              Obligatoire
            </label>
            <button
              type="button"
              onClick={() => removeField(i)}
              disabled={fields.length === 1}
              className="rounded-md px-2 py-1 text-sm text-ink-400 hover:text-coral disabled:cursor-not-allowed disabled:opacity-40"
              title="Retirer ce champ"
            >
              ✕
            </button>
          </div>
        ))}
        <button type="button" onClick={addField} className="text-sm font-medium text-brand-600 hover:text-brand-700">+ Ajouter un champ</button>
      </div>

      {msg && (
        <p className={`rounded-lg px-3 py-2 text-sm ${msg.kind === 'ok' ? 'bg-mint-50 text-mint-700' : 'bg-red-50 text-red-700'}`}>{msg.text}</p>
      )}
      <button
        type="submit"
        disabled={busy || !canSubmit}
        className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-60"
      >
        {busy ? 'Création…' : 'Créer le formulaire'}
      </button>
    </form>
  );
}
