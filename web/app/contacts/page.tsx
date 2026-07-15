'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import {
  listContacts,
  previewImport,
  importCsv,
  updateContact,
  listUserFields,
  createUserField,
  listTags,
  contactIdentity,
  type Contact,
  type ImportReport,
  type ImportPreview,
  type ColumnMapping,
  type UserFieldDef,
  type UserFieldKind,
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
  const [userFields, setUserFields] = useState<UserFieldDef[]>([]);
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);

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

  // Définitions user fields + tags existants (pour la fiche) : chargés une fois.
  useEffect(() => {
    listUserFields(session.tenantId).then(({ fields }) => setUserFields(fields)).catch(() => setUserFields([]));
    listTags(session.tenantId).then(({ tags }) => setTagSuggestions(tags.map((t) => t.tag))).catch(() => setTagSuggestions([]));
  }, [session.tenantId]);

  // Reflète une modif de fiche dans la liste ET la modale, sans recharger toute la liste.
  function onContactUpdated(updated: Contact) {
    setDetail(updated);
    setContacts((list) => list.map((c) => (c.id === updated.id ? updated : c)));
  }
  // Un champ créé depuis la fiche s'ajoute aux définitions (dispo tout de suite + pour les autres contacts).
  function onFieldCreated(def: UserFieldDef) {
    setUserFields((defs) => (defs.some((d) => d.key === def.key) ? defs : [...defs, def]));
  }

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
      {detail && (
        <ContactDetail
          contact={detail}
          userFields={userFields}
          tagSuggestions={tagSuggestions}
          tenantId={session.tenantId}
          onUpdated={onContactUpdated}
          onFieldCreated={onFieldCreated}
          onClose={() => setDetail(null)}
        />
      )}
    </section>
  );
}

// --- Import CSV avec mapping des colonnes ---

const inputCls =
  'w-full rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

// Catégories proposées pour chaque colonne IMPORTÉE. phone/name = attributs standard ; les
// autres presets et « custom » sont des champs perso (fields.<key>). L'inclusion (importer ou
// non la colonne) est gérée à part par une case à cocher.
const CATEGORIES: Array<{ value: string; label: string }> = [
  { value: 'phone', label: 'Téléphone' },
  { value: 'name', label: 'Nom' },
  { value: 'prenom', label: 'Prénom' },
  { value: 'email', label: 'Email' },
  { value: 'ville', label: 'Ville' },
  { value: 'societe', label: 'Société' },
  { value: 'custom', label: 'Champ perso…' },
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
  /** Importer cette colonne ? (case à cocher) */
  include: boolean;
  choice: string;
  customKey: string;
}

function initChoices(preview: ImportPreview): Record<string, Choice> {
  const out: Record<string, Choice> = {};
  for (const h of preview.headers) {
    const m = preview.mapping.columns[h] ?? { target: 'ignore' as const };
    let choice = 'custom';
    let customKey = '';
    if (m.target === 'phone') choice = 'phone';
    else if (m.target === 'name') choice = 'name';
    else if (m.target === 'custom') {
      const k = m.key ?? '';
      if (PRESET_KEYS.includes(k)) choice = k;
      else customKey = k;
    }
    // Par défaut : on coche ce qui est reconnu (téléphone, nom, prénom, email, ville, société),
    // on laisse décoché le reste (bruit CRM), à l'utilisateur de cocher ce qu'il veut garder.
    const include = choice !== 'custom';
    out[h] = { include, choice, customKey };
  }
  return out;
}

function buildMapping(headers: string[], choices: Record<string, Choice>): ColumnMapping {
  const columns: ColumnMapping['columns'] = {};
  for (const h of headers) {
    const c = choices[h] ?? { include: false, choice: 'custom', customKey: '' };
    if (!c.include) columns[h] = { target: 'ignore' };
    else if (c.choice === 'phone') columns[h] = { target: 'phone' };
    else if (c.choice === 'name') columns[h] = { target: 'name' };
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
      const cur = prev[header] ?? { include: true, choice: 'custom', customKey: '' };
      const next: Choice = { ...cur, ...patch };
      // En passant sur « Champ perso… », pré-remplir le nom du champ (slug de l'en-tête) pour
      // qu'il soit éditable, plutôt qu'un champ vide.
      if (patch.choice === 'custom' && next.customKey.trim() === '') next.customKey = slug(header);
      return { ...prev, [header]: next };
    });
  }

  function toggleInclude(header: string) {
    setChoices((prev) => {
      const cur = prev[header] ?? { include: false, choice: 'custom', customKey: '' };
      return { ...prev, [header]: { ...cur, include: !cur.include } };
    });
  }

  const includedCount = preview ? preview.headers.filter((h) => choices[h]?.include).length : 0;
  const hasPhone = preview ? preview.headers.some((h) => choices[h]?.include && choices[h]?.choice === 'phone') : false;

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
        {preview.headers.length} colonnes · {preview.rowCount} lignes. <b>Coche les colonnes à importer</b> et associe chacune à un champ. <b>{includedCount}</b> cochée{includedCount > 1 ? 's' : ''}.
      </p>

      <div className="mt-4 space-y-2">
        {preview.headers.map((h) => {
          const samples = preview.sampleRows.map((r) => r[h]).filter((v) => v && v.trim()).slice(0, 2).join(' · ');
          const c = choices[h] ?? { include: false, choice: 'custom', customKey: '' };
          return (
            <div key={h} className={`flex flex-wrap items-center gap-2 rounded-lg border p-2.5 ${c.include ? 'border-ink-200 bg-white' : 'border-ink-200 bg-ink-50 opacity-70'}`}>
              <input
                type="checkbox"
                checked={c.include}
                onChange={() => toggleInclude(h)}
                title={c.include ? 'Importer cette colonne' : 'Colonne ignorée'}
                className="h-4 w-4 shrink-0 accent-brand-500"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-ink-900">{h}</div>
                {samples && <div className="truncate text-xs text-ink-400">{samples}</div>}
              </div>
              {c.include ? (
                <>
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
                </>
              ) : (
                <span className="shrink-0 text-xs text-ink-400">non importée</span>
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
        {busy
          ? 'Import en cours...'
          : `Importer ${includedCount} colonne${includedCount > 1 ? 's' : ''} et ${preview.rowCount} ligne${preview.rowCount > 1 ? 's' : ''}`}
      </button>
    </section>
  );
}

const OPT_IN_LABEL: Record<string, { text: string; cls: string }> = {
  opted_in: { text: 'opt-in', cls: 'bg-emerald-50 text-emerald-700' },
  opted_out: { text: 'opt-out', cls: 'bg-red-50 text-red-700' },
  unknown: { text: 'inconnu', cls: 'bg-ink-100 text-ink-600' },
};

/** WhatsApp ID (wa_id) : la clé de routage WhatsApp = les chiffres du numéro sans « + », sinon le BSUID. */
function waIdOf(c: Contact): string | null {
  if (c.phoneE164) return c.phoneE164.replace(/[^0-9]/g, '');
  return c.bsuid ?? null;
}

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
      <table className="w-full min-w-[880px] text-sm">
        <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
          <tr>
            <th className="px-4 py-2.5 font-medium">Nom</th>
            <th className="px-4 py-2.5 font-medium">Prénom</th>
            <th className="px-4 py-2.5 font-medium">Téléphone</th>
            <th className="px-4 py-2.5 font-medium">BSUID</th>
            <th className="px-4 py-2.5 font-medium">WhatsApp ID</th>
            <th className="px-4 py-2.5 font-medium">Email</th>
            <th className="px-4 py-2.5 font-medium">Opt-in</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {contacts.map((c) => {
            const badge = OPT_IN_LABEL[c.optInStatus] ?? OPT_IN_LABEL.unknown!;
            const waId = waIdOf(c);
            return (
              <tr key={c.id} onClick={() => onSelect(c)} className="cursor-pointer transition hover:bg-brand-50">
                <td className="px-4 py-2.5 font-medium text-ink-900">{c.profileName ?? <span className="font-normal text-ink-400">-</span>}</td>
                <td className="px-4 py-2.5">{fieldValue(c, 'prenom') ?? <span className="text-ink-400">-</span>}</td>
                <td className="px-4 py-2.5 font-mono text-xs">{c.phoneE164 ?? <span className="text-ink-400">-</span>}</td>
                <td className="px-4 py-2.5 font-mono text-xs">
                  {c.bsuid
                    ? <span className="inline-flex max-w-[160px] items-center gap-1"><span className="truncate" title={c.bsuid}>{c.bsuid}</span></span>
                    : <span className="text-ink-400">-</span>}
                </td>
                <td className="px-4 py-2.5 font-mono text-xs">
                  {waId
                    ? <span className="inline-flex max-w-[160px] items-center gap-1"><span className="truncate" title={waId}>{waId}</span></span>
                    : <span className="text-ink-400">-</span>}
                </td>
                <td className="px-4 py-2.5 text-xs text-ink-700">{fieldValue(c, 'email') ?? <span className="text-ink-400">-</span>}</td>
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

/** Input adapté au type d'un user field. */
function FieldValueInput({ type, value, onChange }: { type: UserFieldKind; value: string; onChange: (v: string) => void }) {
  const cls = 'flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';
  if (type === 'boolean') {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} className={`${cls} bg-white`}>
        <option value="">—</option>
        <option value="oui">oui</option>
        <option value="non">non</option>
      </select>
    );
  }
  const inputType = type === 'number' ? 'number' : type === 'date' ? 'date' : type === 'url' ? 'url' : 'text';
  return <input type={inputType} value={value} onChange={(e) => onChange(e.target.value)} className={cls} placeholder={type === 'url' ? 'https://…' : 'valeur'} />;
}

/**
 * Valeur éditable EN PLACE (Nom, Prénom, champs perso) : affichage + « modifier »/« supprimer » au survol,
 * bascule en input avec ✓/✗. `type` fourni -> input typé (FieldValueInput) ; sinon input texte simple (Nom).
 * `onDelete` absent -> non supprimable. onSave/onDelete renvoient un booléen de succès (reste en édition si échec).
 */
function EditableField({ value, type, mono, busy, editable = true, onSave, onDelete }: {
  value: string;
  type?: UserFieldKind;
  mono?: boolean;
  busy: boolean;
  /** false -> valeur en lecture seule (pas de « modifier ») ; la suppression reste possible si onDelete fourni.
   *  Sert aux champs « orphelins » (sans définition) : les éditer échouerait en 400, mais on peut les retirer. */
  editable?: boolean;
  onSave: (v: string) => Promise<boolean>;
  onDelete?: () => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const begin = () => { setDraft(value); setEditing(true); };
  const commit = async () => { if (await onSave(draft)) setEditing(false); };
  if (editing) {
    return (
      <span className="flex items-center gap-1.5">
        {type ? (
          <FieldValueInput type={type} value={draft} onChange={setDraft} />
        ) : (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void commit(); if (e.key === 'Escape') setEditing(false); }}
            className="min-w-0 flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
        )}
        <button onClick={() => void commit()} disabled={busy} className="shrink-0 text-brand-600 hover:text-brand-700 disabled:opacity-50" aria-label="Enregistrer">✓</button>
        <button onClick={() => setEditing(false)} className="shrink-0 text-ink-400 hover:text-ink-700" aria-label="Annuler">×</button>
      </span>
    );
  }
  return (
    <span className="group flex items-center gap-2">
      <span className={`${mono ? 'font-mono ' : ''}break-words text-ink-900`}>{value !== '' ? value : '-'}</span>
      {editable && (
        <button onClick={begin} className="shrink-0 text-xs text-ink-400 opacity-0 transition hover:text-brand-600 group-hover:opacity-100" aria-label="Modifier">modifier</button>
      )}
      {onDelete && value !== '' && (
        <button onClick={() => void onDelete()} disabled={busy} className="shrink-0 text-xs text-ink-400 opacity-0 transition hover:text-coral group-hover:opacity-100 disabled:opacity-50" aria-label="Supprimer">supprimer</button>
      )}
    </span>
  );
}

/** Fiche détail d'un contact : attributs, champs perso (libellé + valeur), tags. Éditable : Nom, Prénom, valeurs
 *  de champs (modif/suppression), ajout d'un champ, affecter/retirer un tag. Téléphone + BSUID en lecture seule. */
function ContactDetail({
  contact,
  userFields,
  tagSuggestions,
  tenantId,
  onUpdated,
  onFieldCreated,
  onClose,
}: {
  contact: Contact;
  userFields: UserFieldDef[];
  tagSuggestions: string[];
  tenantId: string;
  onUpdated: (c: Contact) => void;
  onFieldCreated: (def: UserFieldDef) => void;
  onClose: () => void;
}) {
  const badge = OPT_IN_LABEL[contact.optInStatus] ?? OPT_IN_LABEL.unknown!;
  const defByKey = new Map(userFields.map((d) => [d.key, d]));
  // 'prenom' est déjà affiché dans le bloc fixe ci-dessus -> l'exclure de la section Champs (pas de doublon).
  const fieldEntries = Object.entries(contact.fields ?? {}).filter(([k, v]) => k !== 'prenom' && v != null && String(v).trim() !== '');
  const filledKeys = new Set([...fieldEntries.map(([k]) => k), 'prenom']);
  const addable = userFields.filter((d) => !filledKeys.has(d.key));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');
  const [newTag, setNewTag] = useState('');
  // Création d'un NOUVEAU champ (pas seulement piocher dans l'existant) depuis la fiche.
  const [creatingField, setCreatingField] = useState(false);
  const [cLabel, setCLabel] = useState('');
  const [cType, setCType] = useState<UserFieldKind>('text');
  const [cVal, setCVal] = useState('');
  // Champ déjà créé mais dont la pose de valeur a échoué : on le réutilise au retry (évite un 409).
  const [createdRef, setCreatedRef] = useState<UserFieldDef | null>(null);

  const selectedDef = defByKey.get(newKey);

  async function apply(patch: { fields?: Record<string, string>; removeFields?: string[]; addTags?: string[]; removeTags?: string[]; profileName?: string | null }) {
    setBusy(true);
    setError(null);
    try {
      const { contact: updated } = await updateContact(tenantId, contact.id, patch);
      onUpdated(updated);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Modification impossible');
      return false;
    } finally {
      setBusy(false);
    }
  }

  // Enregistre une valeur de champ en s'assurant que le user field existe (sinon la route répond « champ
  // inconnu »). Sert au Prénom d'un contact créé par inbound (pas d'import -> pas encore de champ prenom).
  // Valeur vide -> on supprime la valeur (pas de champ vide côté serveur).
  async function saveFieldEnsuringDef(key: string, label: string, value: string): Promise<boolean> {
    const v = value.trim();
    if (v === '') return apply({ removeFields: [key] });
    if (!defByKey.has(key)) {
      try { const def = await createUserField(tenantId, { label, type: 'text' }); onFieldCreated(def); }
      catch { /* course : le champ peut déjà exister -> on tente l'apply quand même */ }
    }
    return apply({ fields: { [key]: v } });
  }

  async function addField() {
    if (!newKey || newVal.trim() === '') return;
    if (await apply({ fields: { [newKey]: newVal.trim() } })) { setNewKey(''); setNewVal(''); }
  }
  // Crée un nouveau user field (POST) PUIS pose sa valeur sur ce contact, en une fois. Si la pose de
  // valeur échoue (ex. valeur invalide pour le type), on garde le champ créé : un retry corrige juste la
  // valeur sans recréer le champ (donc pas de 409 « existe déjà »).
  async function createAndAddField() {
    const label = cLabel.trim();
    if (label === '' || cVal.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      let def = createdRef && createdRef.label === label ? createdRef : null;
      if (!def) {
        def = await createUserField(tenantId, { label, type: cType });
        onFieldCreated(def);
        setCreatedRef(def);
      }
      const ok = await apply({ fields: { [def.key]: cVal.trim() } });
      if (ok) { setCreatingField(false); setCLabel(''); setCVal(''); setCType('text'); setCreatedRef(null); }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Création du champ impossible');
    } finally {
      setBusy(false);
    }
  }
  async function addTag() {
    const t = newTag.trim();
    if (t === '') return;
    if (await apply({ addTags: [t] })) setNewTag('');
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold tracking-tight text-ink-900">{contact.profileName ?? contactIdentity(contact) ?? '-'}</h3>
            <p className="font-mono text-xs text-ink-400">{contactIdentity(contact) ?? '-'}</p>
          </div>
          <button onClick={onClose} className="text-2xl leading-none text-ink-400 hover:text-ink-700">×</button>
        </div>

        <div className="mt-4 grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-2 text-sm">
          <span className="text-ink-400">Nom</span>
          <EditableField value={contact.profileName ?? ''} busy={busy} onSave={(v) => apply({ profileName: v.trim() === '' ? null : v.trim() })} />
          <span className="text-ink-400">Prénom</span>
          <EditableField value={fieldValue(contact, 'prenom') ?? ''} type="text" busy={busy} onSave={(v) => saveFieldEnsuringDef('prenom', 'Prénom', v)} onDelete={() => apply({ removeFields: ['prenom'] })} />
          <span className="text-ink-400">Téléphone</span>
          <span className="font-mono text-ink-900" title="Le numéro (identité/routage WhatsApp) n'est pas modifiable">{contact.phoneE164 ?? '-'}</span>
          {contact.bsuid && (
            <>
              <span className="text-ink-400">Compte WhatsApp</span>
              <span className="font-mono text-ink-900" title="BSUID : identifiant WhatsApp unique d'un client qui n'a pas partagé son numéro (non modifiable)">{contact.bsuid}</span>
            </>
          )}
          <span className="text-ink-400">Consentement</span>
          <span><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.cls}`}>{badge.text}</span></span>
          <span className="text-ink-400">Ajouté le</span>
          <span className="text-ink-900">{new Date(contact.createdAt).toLocaleDateString('fr-FR')}</span>
        </div>

        {error && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <div className="mt-5">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Tags</h4>
          <div className="flex flex-wrap items-center gap-1.5">
            {(contact.tags ?? []).map((t) => (
              <span key={t} className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
                {t}
                <button onClick={() => void apply({ removeTags: [t] })} disabled={busy} className="text-brand-400 hover:text-coral" aria-label={`Retirer ${t}`}>×</button>
              </span>
            ))}
            {(contact.tags ?? []).length === 0 && <span className="text-sm text-ink-400">Aucun tag.</span>}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <input
              list="tag-suggestions"
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void addTag(); }}
              placeholder="Ajouter un tag…"
              className="flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
            <datalist id="tag-suggestions">{tagSuggestions.map((t) => <option key={t} value={t} />)}</datalist>
            <button onClick={addTag} disabled={busy || newTag.trim() === ''} className="rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50">Ajouter</button>
          </div>
        </div>

        <div className="mt-5">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Champs</h4>
          {fieldEntries.length === 0 ? (
            <p className="text-sm text-ink-400">Aucun champ perso.</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-ink-200">
              {fieldEntries.map(([k, v], i) => (
                <div key={k} className={`grid grid-cols-[130px_1fr] items-center gap-3 px-3 py-1.5 text-sm ${i % 2 ? 'bg-ink-50' : 'bg-white'}`}>
                  <span className="truncate text-ink-500">{defByKey.get(k)?.label ?? k}</span>
                  <EditableField
                    value={String(v)}
                    type={defByKey.get(k)?.type ?? 'text'}
                    busy={busy}
                    editable={defByKey.has(k)}
                    onSave={(nv) => (nv.trim() === '' ? apply({ removeFields: [k] }) : apply({ fields: { [k]: nv.trim() } }))}
                    onDelete={() => apply({ removeFields: [k] })}
                  />
                </div>
              ))}
            </div>
          )}
          <div className="mt-2 space-y-2">
            {addable.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <select value={newKey} onChange={(e) => { setNewKey(e.target.value); setNewVal(''); }} className="rounded-lg border border-ink-300 bg-white px-2 py-2 text-sm text-ink-800">
                  <option value="">Ajouter un champ existant…</option>
                  {addable.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
                </select>
                {selectedDef && (
                  <>
                    <FieldValueInput type={selectedDef.type} value={newVal} onChange={setNewVal} />
                    <button onClick={addField} disabled={busy || newVal.trim() === ''} className="rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50">Ajouter</button>
                  </>
                )}
              </div>
            )}
            {!creatingField ? (
              <button onClick={() => setCreatingField(true)} className="text-sm font-medium text-brand-600 hover:text-brand-700">+ Créer un nouveau champ</button>
            ) : (
              <div className="space-y-2 rounded-lg border border-brand-200 bg-brand-50/40 p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <input value={cLabel} onChange={(e) => setCLabel(e.target.value)} placeholder="Nom du champ (ex. Métier)" className="flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100" />
                  <select value={cType} onChange={(e) => setCType(e.target.value as UserFieldKind)} className="rounded-lg border border-ink-300 bg-white px-2 py-2 text-sm text-ink-800">
                    <option value="text">texte</option>
                    <option value="number">nombre</option>
                    <option value="date">date</option>
                    <option value="boolean">oui/non</option>
                    <option value="url">lien</option>
                  </select>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <FieldValueInput type={cType} value={cVal} onChange={setCVal} />
                  <button onClick={createAndAddField} disabled={busy || cLabel.trim() === '' || cVal.trim() === ''} className="rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50">Créer et ajouter</button>
                  <button onClick={() => { setCreatingField(false); setCLabel(''); setCVal(''); setCreatedRef(null); }} className="text-sm text-ink-400 hover:text-ink-700">Annuler</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
