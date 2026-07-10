'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import {
  listContacts,
  previewImport,
  importCsv,
  type Contact,
  type ImportReport,
  type ImportPreview,
  type ColumnMapping,
} from '@/lib/api';

export default function ContactsPage() {
  return <AppShell active="contacts">{(session) => <ContactsInner session={session} />}</AppShell>;
}

function ContactsInner({ session }: { session: Session }) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'list' | 'import'>('list');
  const [detail, setDetail] = useState<Contact | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const { contacts } = await listContacts(session.tenantId, { limit: 500 });
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

  if (mode === 'import') {
    return (
      <div className="mx-auto max-w-3xl">
        <button onClick={() => setMode('list')} className="mb-4 text-sm text-brand-600 hover:underline">
          ← Retour aux contacts
        </button>
        <ImportScreen tenantId={session.tenantId} onImported={() => { void reload(); setMode('list'); }} />
      </div>
    );
  }

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold tracking-tight text-ink-900">Contacts ({contacts.length})</h2>
        <div className="flex items-center gap-3">
          <button onClick={reload} className="text-xs text-brand-600 hover:underline">Rafraîchir</button>
          <button
            onClick={() => setMode('import')}
            className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-600"
          >
            + Importer un CSV
          </button>
        </div>
      </div>
      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <ContactsTable contacts={contacts} loading={loading} onSelect={setDetail} />
      {detail && <ContactDetail contact={detail} onClose={() => setDetail(null)} />}
    </section>
  );
}

// --- Import CSV avec mapping des colonnes ---

const inputCls =
  'w-full rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

// Catégories proposées pour chaque colonne. phone/name = attributs standard ; les autres presets
// et « custom » sont des champs perso (fields.<key>).
const CATEGORIES: Array<{ value: string; label: string }> = [
  { value: 'phone', label: 'Téléphone' },
  { value: 'name', label: 'Nom' },
  { value: 'prenom', label: 'Prénom' },
  { value: 'email', label: 'Email' },
  { value: 'ville', label: 'Ville' },
  { value: 'societe', label: 'Société' },
  { value: 'custom', label: 'Champ perso…' },
  { value: 'ignore', label: 'Ignorer' },
];
const PRESET_KEYS = ['prenom', 'email', 'ville', 'societe'];

function slug(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

interface Choice {
  choice: string;
  customKey: string;
}

function initChoices(preview: ImportPreview): Record<string, Choice> {
  const out: Record<string, Choice> = {};
  for (const h of preview.headers) {
    const m = preview.mapping.columns[h] ?? { target: 'ignore' as const };
    if (m.target === 'phone') out[h] = { choice: 'phone', customKey: '' };
    else if (m.target === 'name') out[h] = { choice: 'name', customKey: '' };
    else if (m.target === 'ignore') out[h] = { choice: 'ignore', customKey: '' };
    else {
      const k = m.key ?? '';
      out[h] = PRESET_KEYS.includes(k) ? { choice: k, customKey: '' } : { choice: 'custom', customKey: k };
    }
  }
  return out;
}

function buildMapping(headers: string[], choices: Record<string, Choice>): ColumnMapping {
  const columns: ColumnMapping['columns'] = {};
  for (const h of headers) {
    const c = choices[h] ?? { choice: 'ignore', customKey: '' };
    if (c.choice === 'phone') columns[h] = { target: 'phone' };
    else if (c.choice === 'name') columns[h] = { target: 'name' };
    else if (c.choice === 'ignore') columns[h] = { target: 'ignore' };
    else if (c.choice === 'custom') columns[h] = { target: 'custom', key: slug(c.customKey) || slug(h) };
    else columns[h] = { target: 'custom', key: c.choice };
  }
  return { columns };
}

function ImportScreen({ tenantId, onImported }: { tenantId: string; onImported: () => void }) {
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [optIn, setOptIn] = useState(true);
  const [tagsInput, setTagsInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [showPaste, setShowPaste] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);

  // Analyse le CSV (depuis un fichier ou du texte collé) et enchaîne DIRECTEMENT sur le mapping.
  // On n'affiche jamais les données brutes.
  async function analyze(src?: string) {
    const text = src ?? csv;
    if (text.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      const p = await previewImport(tenantId, text);
      setCsv(text);
      setPreview(p);
      setChoices(initChoices(p));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analyse impossible');
    } finally {
      setBusy(false);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    await analyze(await file.text());
  }

  async function submit() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const tags = tagsInput.split(',').map((t) => t.trim()).filter((t) => t !== '');
      const mapping = buildMapping(preview.headers, choices);
      const r = await importCsv(tenantId, csv, optIn, tags, mapping);
      setReport(r);
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import impossible');
    } finally {
      setBusy(false);
    }
  }

  function setChoice(header: string, patch: Partial<Choice>) {
    setChoices((prev) => {
      const cur = prev[header] ?? { choice: 'ignore', customKey: '' };
      const next: Choice = { ...cur, ...patch };
      // En passant sur « Champ perso… », pré-remplir le nom du champ (slug de l'en-tête) pour
      // qu'il soit éditable, plutôt qu'un champ vide.
      if (patch.choice === 'custom' && next.customKey.trim() === '') next.customKey = slug(header);
      return { ...prev, [header]: next };
    });
  }

  const hasPhone = preview ? preview.headers.some((h) => choices[h]?.choice === 'phone') : false;

  // Étape 1 : choisir le fichier. On lit juste les en-têtes et on enchaîne sur le mapping,
  // sans jamais afficher les données.
  if (!preview) {
    return (
      <section className="rounded-2xl border border-ink-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold tracking-tight text-ink-900">Importer un CSV</h2>
        <p className="mt-1 text-xs text-ink-500">On lit la 1re ligne (les en-têtes) et tu associes chaque colonne à un champ. Tes données ne s&apos;affichent pas ici.</p>

        <label className="mt-4 flex cursor-pointer flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed border-ink-300 px-3 py-10 text-center hover:border-brand-500">
          <svg viewBox="0 0 24 24" className="h-8 w-8 text-ink-300" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4M7 9l5-5 5 5M4 20h16" /></svg>
          <span className="text-sm font-medium text-ink-700">{busy ? 'Analyse en cours…' : 'Choisir un fichier .csv'}</span>
          <span className="text-xs text-ink-400">{fileName ?? 'ou glisse-le ici'}</span>
          <input type="file" accept=".csv,text/csv" onChange={onFile} className="hidden" disabled={busy} />
        </label>

        {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <div className="mt-3 text-center">
          <button onClick={() => setShowPaste((s) => !s)} className="text-xs text-ink-400 hover:text-brand-600">
            {showPaste ? 'masquer' : 'ou coller le texte à la place'}
          </button>
        </div>
        {showPaste && (
          <div className="mt-2">
            <textarea
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              rows={4}
              placeholder={'Prénom,Nom,Téléphone\nJulie,Dumas,+33612345678'}
              className="w-full rounded-lg border border-ink-300 px-3 py-2 font-mono text-xs outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
            <button
              onClick={() => analyze()}
              disabled={busy || csv.trim() === ''}
              className="mt-2 w-full rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
            >
              {busy ? 'Analyse...' : 'Analyser →'}
            </button>
          </div>
        )}
      </section>
    );
  }

  // Étape 2 : mapping des colonnes.
  return (
    <section className="rounded-2xl border border-ink-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold tracking-tight text-ink-900">Associer les colonnes</h2>
        <button onClick={() => { setPreview(null); setReport(null); }} className="text-xs text-brand-600 hover:underline">
          Changer de fichier
        </button>
      </div>
      <p className="mt-1 text-xs text-ink-500">
        {preview.headers.length} colonnes · {preview.rowCount} lignes. Les suggestions sont modifiables : passe une colonne en <b>Champ perso…</b> pour la nommer toi-même, ou en <b>Ignorer</b>.
      </p>

      <div className="mt-4 space-y-2">
        {preview.headers.map((h) => {
          const samples = preview.sampleRows.map((r) => r[h]).filter((v) => v && v.trim()).slice(0, 2).join(' · ');
          const c = choices[h] ?? { choice: 'ignore', customKey: '' };
          const ignored = c.choice === 'ignore';
          return (
            <div key={h} className={`flex flex-wrap items-center gap-2 rounded-lg border border-ink-200 p-2.5 ${ignored ? 'opacity-60' : ''}`}>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-ink-900">{h}</div>
                {samples && <div className="truncate text-xs text-ink-400">{samples}</div>}
              </div>
              <span className="text-ink-300">→</span>
              <select
                value={c.choice}
                onChange={(e) => setChoice(h, { choice: e.target.value })}
                className="shrink-0 rounded-lg border border-ink-300 px-2.5 py-1.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              >
                {CATEGORIES.map((cat) => (
                  <option key={cat.value} value={cat.value}>{cat.label}</option>
                ))}
              </select>
              {c.choice === 'custom' && (
                <input
                  value={c.customKey}
                  onChange={(e) => setChoice(h, { customKey: e.target.value })}
                  placeholder="nom du champ"
                  className="w-32 shrink-0 rounded-lg border border-ink-300 px-2.5 py-1.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                />
              )}
            </div>
          );
        })}
      </div>

      {!hasPhone && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
          Associe au moins une colonne à <b>Téléphone</b> : c&apos;est la clé d&apos;un contact.
        </p>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm font-medium text-ink-700">Tags (optionnel)</label>
          <input value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} placeholder="salon-2026, prospect" className={inputCls} />
        </div>
        <label className="flex items-end gap-2 pb-2 text-sm text-ink-700">
          <input type="checkbox" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} className="rounded" />
          Consentement (opt-in) donné
        </label>
      </div>

      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {report && (
        <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          <b>{report.created}</b> créés, <b>{report.updated}</b> mis à jour, <b>{report.skipped}</b> ignorés.
          {report.errors.length > 0 && (
            <ul className="mt-1 list-inside list-disc text-xs text-emerald-700">
              {report.errors.slice(0, 5).map((e, i) => (
                <li key={i}>ligne {e.line} : {e.reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <button
        onClick={submit}
        disabled={busy || !hasPhone}
        className="mt-4 w-full rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
      >
        {busy ? 'Import en cours...' : `Importer ${preview.rowCount} lignes`}
      </button>
    </section>
  );
}

const OPT_IN_LABEL: Record<string, { text: string; cls: string }> = {
  opted_in: { text: 'opt-in', cls: 'bg-emerald-50 text-emerald-700' },
  opted_out: { text: 'opt-out', cls: 'bg-red-50 text-red-700' },
  unknown: { text: 'inconnu', cls: 'bg-ink-100 text-ink-600' },
};

/** Valeur d'un champ perso (insensible à la casse pour les clés type prenom/prénom). */
function fieldValue(c: Contact, key: string): string | null {
  const f = c.fields ?? {};
  const v = f[key] ?? f[key.toLowerCase()];
  return v == null || String(v).trim() === '' ? null : String(v);
}

function ContactsTable({ contacts, loading, onSelect }: { contacts: Contact[]; loading: boolean; onSelect: (c: Contact) => void }) {
  if (loading) return <p className="text-sm text-ink-500">Chargement...</p>;
  if (contacts.length === 0)
    return (
      <div className="rounded-2xl border border-dashed border-ink-300 bg-white px-4 py-10 text-center text-sm text-ink-500">
        Aucun contact pour l&apos;instant. Clique « + Importer un CSV » pour commencer.
      </div>
    );
  return (
    <div className="overflow-x-auto rounded-2xl border border-ink-200 bg-white shadow-sm">
      <table className="w-full min-w-[520px] text-sm">
        <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
          <tr>
            <th className="px-4 py-2.5 font-medium">Nom</th>
            <th className="px-4 py-2.5 font-medium">Prénom</th>
            <th className="px-4 py-2.5 font-medium">Téléphone</th>
            <th className="px-4 py-2.5 font-medium">Opt-in</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {contacts.map((c) => {
            const badge = OPT_IN_LABEL[c.optInStatus] ?? OPT_IN_LABEL.unknown!;
            return (
              <tr key={c.id} onClick={() => onSelect(c)} className="cursor-pointer transition hover:bg-brand-50">
                <td className="px-4 py-2.5 font-medium text-ink-900">{c.profileName ?? <span className="font-normal text-ink-400">-</span>}</td>
                <td className="px-4 py-2.5">{fieldValue(c, 'prenom') ?? <span className="text-ink-400">-</span>}</td>
                <td className="px-4 py-2.5 font-mono text-xs">{c.phoneE164 ?? '-'}</td>
                <td className="px-4 py-2.5">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.cls}`}>{badge.text}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Fiche détail d'un contact : tous les attributs, champs perso et tags. */
function ContactDetail({ contact, onClose }: { contact: Contact; onClose: () => void }) {
  const badge = OPT_IN_LABEL[contact.optInStatus] ?? OPT_IN_LABEL.unknown!;
  const fieldEntries = Object.entries(contact.fields ?? {}).filter(([, v]) => v != null && String(v).trim() !== '');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold tracking-tight text-ink-900">{contact.profileName ?? `+${contact.phoneE164 ?? ''}`}</h3>
            <p className="font-mono text-xs text-ink-400">{contact.phoneE164 ?? '-'}</p>
          </div>
          <button onClick={onClose} className="text-2xl leading-none text-ink-400 hover:text-ink-700">×</button>
        </div>

        <div className="mt-4 grid grid-cols-[110px_1fr] gap-x-3 gap-y-2 text-sm">
          <span className="text-ink-400">Nom</span>
          <span className="text-ink-900">{contact.profileName ?? '-'}</span>
          <span className="text-ink-400">Prénom</span>
          <span className="text-ink-900">{fieldValue(contact, 'prenom') ?? '-'}</span>
          <span className="text-ink-400">Téléphone</span>
          <span className="font-mono text-ink-900">{contact.phoneE164 ?? '-'}</span>
          <span className="text-ink-400">Consentement</span>
          <span><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.cls}`}>{badge.text}</span></span>
          <span className="text-ink-400">Ajouté le</span>
          <span className="text-ink-900">{new Date(contact.createdAt).toLocaleDateString('fr-FR')}</span>
        </div>

        <div className="mt-5">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Tags</h4>
          {(contact.tags ?? []).length === 0 ? (
            <p className="text-sm text-ink-400">Aucun tag.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {contact.tags.map((t) => (
                <span key={t} className="rounded-md bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">{t}</span>
              ))}
            </div>
          )}
        </div>

        <div className="mt-5">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Champs</h4>
          {fieldEntries.length === 0 ? (
            <p className="text-sm text-ink-400">Aucun champ perso.</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-ink-200">
              {fieldEntries.map(([k, v], i) => (
                <div key={k} className={`grid grid-cols-[130px_1fr] gap-3 px-3 py-1.5 text-sm ${i % 2 ? 'bg-ink-50' : 'bg-white'}`}>
                  <span className="truncate text-ink-500">{k}</span>
                  <span className="break-words text-ink-900">{String(v)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
