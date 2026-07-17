'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { previewImport, importCsv, type ImportReport, type ImportPreview, type ColumnMapping } from '@/lib/api';

// --- Import CSV avec mapping des colonnes (composant partagé Contacts + Campagne) ---

const inputCls =
  'w-full rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

// Catégories proposées pour chaque colonne IMPORTÉE. phone/name = attributs standard ; les
// autres presets et « custom » sont des champs perso (fields.<key>). L'inclusion (importer ou
// non la colonne) est gérée à part par une case à cocher. Les CATEGORIES (avec labels traduits)
// sont construites DANS CsvImport car useT() est inappelable au niveau module.
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

/**
 * Flux d'import CSV réutilisable : fichier/collage -> previewImport -> mapping des colonnes -> opt-in + tags
 * -> importCsv -> rapport. Utilisé tel quel dans l'onglet Contacts (tags optionnels) et comme source
 * « Import fichier » d'une campagne (requireTag : les tags servent alors à cibler les contacts importés).
 *
 * `onImported` reçoit `{ report, tags }` où `tags` = la liste normalisée réellement envoyée à importCsv
 * (trim, non vides, dédupliqués) : l'appelant campagne s'en sert pour filtrer.
 */
export function CsvImport({ tenantId, requireTag = false, onImported, onBusyChange }: {
  tenantId: string;
  requireTag?: boolean;
  onImported: (result: { report: ImportReport; tags: string[] }) => void;
  /** Remonte l'état « occupé » (analyse/import en vol) : l'appelant peut geler ce qui le démonterait. */
  onBusyChange?: (busy: boolean) => void;
}): React.JSX.Element {
  const t = useT();
  // Catégories des colonnes importées : les `value` restent des clés techniques, seuls les labels sont traduits.
  const CATEGORIES: Array<{ value: string; label: string }> = [
    { value: 'phone', label: t('Téléphone', 'Phone') },
    { value: 'name', label: t('Nom', 'Name') },
    { value: 'prenom', label: t('Prénom', 'First name') },
    { value: 'email', label: t('Email', 'Email') },
    { value: 'ville', label: t('Ville', 'City') },
    { value: 'societe', label: t('Société', 'Company') },
    { value: 'custom', label: t('Champ perso…', 'Custom field…') },
  ];
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

  // Tags réellement posés : trim, non vides, dédup. Sert au bouton (requireTag) ET à onImported.
  const normalizedTags = Array.from(new Set(tagsInput.split(',').map((s) => s.trim()).filter((s) => s !== '')));
  const tagsMissing = requireTag && normalizedTags.length === 0;
  // Remonte l'état occupé (l'appelant désactive ce qui démonterait ce composant pendant un import en vol).
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

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
      setError(err instanceof Error ? err.message : t('Analyse impossible', 'Analysis failed'));
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
      const mapping = buildMapping(preview.headers, choices);
      const r = await importCsv(tenantId, csv, optIn, normalizedTags, mapping);
      setReport(r);
      onImported({ report: r, tags: normalizedTags });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Import impossible', 'Import failed'));
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
        <h2 className="text-base font-semibold tracking-tight text-ink-900">{t('Importer un CSV', 'Import a CSV')}</h2>
        <p className="mt-1 text-xs text-ink-500">{t("On lit la 1re ligne (les en-têtes) et tu associes chaque colonne à un champ. Tes données ne s'affichent pas ici.", 'We read the first row (the headers) and you map each column to a field. Your data is not displayed here.')}</p>

        <label className="mt-4 flex cursor-pointer flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed border-ink-300 px-3 py-10 text-center hover:border-brand-500">
          <svg viewBox="0 0 24 24" className="h-8 w-8 text-ink-300" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4M7 9l5-5 5 5M4 20h16" /></svg>
          <span className="text-sm font-medium text-ink-700">{busy ? t('Analyse en cours…', 'Analyzing…') : t('Choisir un fichier .csv', 'Choose a .csv file')}</span>
          <span className="text-xs text-ink-400">{fileName ?? t('ou glisse-le ici', 'or drag it here')}</span>
          <input type="file" accept=".csv,text/csv" onChange={onFile} className="hidden" disabled={busy} />
        </label>

        {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <div className="mt-3 text-center">
          <button onClick={() => setShowPaste((s) => !s)} className="text-xs text-ink-400 hover:text-brand-600">
            {showPaste ? t('masquer', 'hide') : t('ou coller le texte à la place', 'or paste the text instead')}
          </button>
        </div>
        {showPaste && (
          <div className="mt-2">
            <textarea
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              rows={4}
              placeholder={t('Prénom,Nom,Téléphone\nJulie,Dumas,+33612345678', 'First name,Name,Phone\nJulie,Dumas,+33612345678')}
              className="w-full rounded-lg border border-ink-300 px-3 py-2 font-mono text-xs outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
            <button
              onClick={() => analyze()}
              disabled={busy || csv.trim() === ''}
              className="mt-2 w-full rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
            >
              {busy ? t('Analyse...', 'Analyzing...') : t('Analyser →', 'Analyze →')}
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
        <h2 className="text-base font-semibold tracking-tight text-ink-900">{t('Associer les colonnes', 'Map the columns')}</h2>
        <button onClick={() => { setPreview(null); setReport(null); }} className="text-xs text-brand-600 hover:underline">
          {t('Changer de fichier', 'Change file')}
        </button>
      </div>
      <p className="mt-1 text-xs text-ink-500">
        {preview.headers.length} {t('colonnes', 'columns')} · {preview.rowCount} {t('lignes.', 'rows.')} <b>{t('Coche les colonnes à importer', 'Check the columns to import')}</b> {t('et associe chacune à un champ.', 'and map each one to a field.')} <b>{includedCount}</b> {t(`cochée${includedCount > 1 ? 's' : ''}`, 'checked')}.
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
                title={c.include ? t('Importer cette colonne', 'Import this column') : t('Colonne ignorée', 'Ignored column')}
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
                      placeholder={t('nom du champ', 'field name')}
                      className="w-32 shrink-0 rounded-lg border border-ink-300 px-2.5 py-1.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                    />
                  )}
                </>
              ) : (
                <span className="shrink-0 text-xs text-ink-400">{t('non importée', 'not imported')}</span>
              )}
            </div>
          );
        })}
      </div>

      {!hasPhone && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
          {t('Associe au moins une colonne à', 'Map at least one column to')} <b>{t('Téléphone', 'Phone')}</b> {t(": c'est la clé d'un contact.", ": it's a contact's key.")}
        </p>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm font-medium text-ink-700">
            {requireTag ? t('Tags (obligatoire)', 'Tags (required)') : t('Tags (optionnel)', 'Tags (optional)')}
          </label>
          <input value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} placeholder={t('salon-2026, prospect', 'expo-2026, prospect')} className={inputCls} />
          {requireTag && tagsMissing && (
            <p className="mt-1 text-xs text-amber-600">{t('Ajoute au moins un tag pour retrouver ces contacts dans ta campagne.', 'Add at least one tag to find these contacts in your campaign.')}</p>
          )}
        </div>
        <label className="flex items-end gap-2 pb-2 text-sm text-ink-700">
          <input type="checkbox" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} className="rounded" />
          {t('Consentement (opt-in) donné', 'Consent (opt-in) given')}
        </label>
      </div>

      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {report && (
        <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          <b>{report.created}</b> {t('créés,', 'created,')} <b>{report.updated}</b> {t('mis à jour,', 'updated,')} <b>{report.skipped}</b> {t('ignorés.', 'skipped.')}
          {report.errors.length > 0 && (
            <ul className="mt-1 list-inside list-disc text-xs text-emerald-700">
              {report.errors.slice(0, 5).map((e, i) => (
                <li key={i}>{t('ligne', 'row')} {e.line} : {e.reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <button
        onClick={submit}
        disabled={busy || !hasPhone || tagsMissing}
        className="mt-4 w-full rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
      >
        {busy
          ? t('Import en cours...', 'Importing...')
          : t(
              `Importer ${includedCount} colonne${includedCount > 1 ? 's' : ''} et ${preview.rowCount} ligne${preview.rowCount > 1 ? 's' : ''}`,
              `Import ${includedCount} column${includedCount > 1 ? 's' : ''} and ${preview.rowCount} row${preview.rowCount > 1 ? 's' : ''}`,
            )}
      </button>
    </section>
  );
}
