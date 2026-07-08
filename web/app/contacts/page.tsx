'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import { listContacts, importCsv, type Contact, type ImportReport } from '@/lib/api';

export default function ContactsPage() {
  return <AppShell active="contacts">{(session) => <ContactsInner session={session} />}</AppShell>;
}

function ContactsInner({ session }: { session: Session }) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const { contacts } = await listContacts(session.tenantId);
      setContacts(contacts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chargement impossible');
    } finally {
      setLoading(false);
    }
  }, [session.tenantId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
      <ImportPanel tenantId={session.tenantId} onImported={reload} />
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700">Contacts ({contacts.length})</h2>
          <button onClick={reload} className="text-xs text-brand-600 hover:underline">Rafraîchir</button>
        </div>
        {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <ContactsTable contacts={contacts} loading={loading} />
      </section>
    </div>
  );
}

function ImportPanel({ tenantId, onImported }: { tenantId: string; onImported: () => void }) {
  const [csv, setCsv] = useState('');
  const [optIn, setOptIn] = useState(true);
  const [tagsInput, setTagsInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) setCsv(await file.text());
  }

  async function submit() {
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const tags = tagsInput.split(',').map((t) => t.trim()).filter((t) => t !== '');
      const r = await importCsv(tenantId, csv, optIn, tags);
      setReport(r);
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import impossible');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="h-fit rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-700">Importer un CSV</h2>
      <p className="mt-1 text-xs text-slate-500">
        1re ligne = en-têtes. Les colonnes téléphone/nom sont reconnues, le reste devient des champs perso.
      </p>

      <label className="mt-4 flex cursor-pointer items-center justify-center rounded-lg border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-600 hover:border-brand-500 hover:text-brand-600">
        Choisir un fichier .csv
        <input type="file" accept=".csv,text/csv" onChange={onFile} className="hidden" />
      </label>

      <textarea
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
        rows={7}
        placeholder={'Nom,Téléphone,Ville\nJulie,+33612345678,Lyon'}
        className="mt-3 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
      />

      <div className="mt-3">
        <label className="mb-1 block text-sm font-medium text-slate-700">Tags (séparés par des virgules)</label>
        <input
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
          placeholder="salon-2026, prospect"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
        <p className="mt-1 text-xs text-slate-400">Appliqués à tous les contacts de cet import (pour filtrer tes campagnes ensuite).</p>
      </div>

      <label className="mt-3 flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} className="rounded" />
        Ces contacts ont donné leur consentement (opt-in)
      </label>

      <button
        onClick={submit}
        disabled={busy || csv.trim() === ''}
        className="mt-4 w-full rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
      >
        {busy ? 'Import en cours...' : 'Importer'}
      </button>

      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {report && (
        <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          <b>{report.created}</b> créés, <b>{report.updated}</b> mis à jour, <b>{report.skipped}</b> ignorés.
          {report.errors.length > 0 && (
            <ul className="mt-1 list-inside list-disc text-xs text-emerald-700">
              {report.errors.slice(0, 5).map((e, i) => (
                <li key={i}>
                  ligne {e.line} : {e.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

const OPT_IN_LABEL: Record<string, { text: string; cls: string }> = {
  opted_in: { text: 'opt-in', cls: 'bg-emerald-50 text-emerald-700' },
  opted_out: { text: 'opt-out', cls: 'bg-red-50 text-red-700' },
  unknown: { text: 'inconnu', cls: 'bg-slate-100 text-slate-600' },
};

function ContactsTable({ contacts, loading }: { contacts: Contact[]; loading: boolean }) {
  if (loading) return <p className="text-sm text-slate-500">Chargement...</p>;
  if (contacts.length === 0)
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-500">
        Aucun contact pour l&apos;instant. Importe un CSV pour commencer.
      </div>
    );
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2.5 font-medium">Nom</th>
            <th className="px-4 py-2.5 font-medium">Téléphone</th>
            <th className="px-4 py-2.5 font-medium">Consentement</th>
            <th className="px-4 py-2.5 font-medium">Tags</th>
            <th className="px-4 py-2.5 font-medium">Champs</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {contacts.map((c) => {
            const badge = OPT_IN_LABEL[c.optInStatus] ?? OPT_IN_LABEL.unknown!;
            const fieldKeys = Object.keys(c.fields ?? {});
            return (
              <tr key={c.id} className="hover:bg-slate-50">
                <td className="px-4 py-2.5">{c.profileName ?? <span className="text-slate-400">-</span>}</td>
                <td className="px-4 py-2.5 font-mono text-xs">{c.phoneE164 ?? '-'}</td>
                <td className="px-4 py-2.5">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.cls}`}>{badge.text}</span>
                </td>
                <td className="px-4 py-2.5">
                  {(c.tags ?? []).length === 0 ? (
                    <span className="text-slate-400">-</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {c.tags.map((t) => (
                        <span key={t} className="rounded bg-brand-50 px-1.5 py-0.5 text-[11px] text-brand-700">{t}</span>
                      ))}
                    </div>
                  )}
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-500">
                  {fieldKeys.length === 0 ? '-' : fieldKeys.map((k) => `${k}: ${String(c.fields[k])}`).join(', ')}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
