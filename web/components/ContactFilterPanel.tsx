'use client';

import { useState } from 'react';
import { useT } from '@/lib/i18n';
import type { ContactFilters, ContactFieldFilter, ContactFieldOp, UserFieldDef } from '@/lib/api';

/**
 * Panneau de filtres de contacts, CONTRÔLÉ (édite un ContactFilters via onChange). Partagé par le mini-CRM
 * (écran Contacts) ET par la sélection de destinataires d'une campagne : une seule implémentation, pas deux
 * moteurs de recherche parallèles qui divergent. La sérialisation (filtersToQuery) et le parse serveur
 * (parseFilters / normalizeContactFilters) partagent déjà le même format ; ce composant est le miroir UI.
 *
 * Filtres : nom, opt-in, téléphone (commence par / contient), tags (possède ET/OU + ne possède pas), champs
 * perso répétables (contient / ne contient pas / égal / vide / rempli), et un contrôle Email dédié.
 */
export function ContactFilterPanel({ filters, onChange, userFields, tagSuggestions, onClear }: {
  filters: ContactFilters;
  onChange: (f: ContactFilters) => void;
  userFields: UserFieldDef[];
  tagSuggestions: string[];
  onClear: () => void;
}) {
  const t = useT();
  const [tagInput, setTagInput] = useState('');
  const [tagExInput, setTagExInput] = useState('');
  const set = (patch: Partial<ContactFilters>) => onChange({ ...filters, ...patch });
  const inputCls = 'rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

  const tags = filters.tags ?? [];
  const tagsExclude = filters.tagsExclude ?? [];
  const addTag = (v: string) => { const x = v.trim(); if (x && !tags.includes(x)) set({ tags: [...tags, x] }); setTagInput(''); };
  const addTagEx = (v: string) => { const x = v.trim(); if (x && !tagsExclude.includes(x)) set({ tagsExclude: [...tagsExclude, x] }); setTagExInput(''); };
  const rmTag = (x: string) => set({ tags: tags.filter((v) => v !== x) });
  const rmTagEx = (x: string) => set({ tagsExclude: tagsExclude.filter((v) => v !== x) });

  // Filtres de champ (hors email, géré à part). fieldFilters de la vue = tous sauf key === 'email'.
  const fieldRows = (filters.fieldFilters ?? []).filter((f) => f.key !== 'email');
  const emailRow = (filters.fieldFilters ?? []).find((f) => f.key === 'email');
  const setFieldFilters = (rows: ContactFieldFilter[], email: ContactFieldFilter | undefined) =>
    set({ fieldFilters: email ? [...rows, email] : rows });
  // MIROIR EXACT de la liste d'options du <select> (qui exclut 'email', géré par le contrôle Email dédié) : sinon
  // une ligne par défaut key='email' serait filtrée hors des lignes génériques ET écraserait le filtre Email.
  const fieldKeys = userFields.filter((d) => d.key !== 'email');
  const addRow = () => setFieldFilters([...fieldRows, { key: fieldKeys[0]?.key ?? '', op: 'contains', value: '' }], emailRow);
  const updRow = (i: number, patch: Partial<ContactFieldFilter>) =>
    setFieldFilters(fieldRows.map((r, j) => (j === i ? { ...r, ...patch } : r)), emailRow);
  const rmRow = (i: number) => setFieldFilters(fieldRows.filter((_, j) => j !== i), emailRow);

  // Email : mode dérivé de la ligne email courante.
  const emailMode: '' | 'not_empty' | 'empty' | 'eq' = emailRow ? (emailRow.op === 'not_contains' ? '' : (emailRow.op as 'not_empty' | 'empty' | 'eq')) : '';
  const setEmail = (m: '' | 'not_empty' | 'empty' | 'eq', value = emailRow?.value ?? '') =>
    setFieldFilters(fieldRows, m === '' ? undefined : { key: 'email', op: m, value: m === 'eq' ? value : '' });

  const opLabels: Record<ContactFieldOp, string> = {
    contains: t('contient', 'contains'),
    not_contains: t('ne contient pas', "doesn't contain"),
    eq: t('égal à', 'equals'),
    empty: t('vide', 'empty'),
    not_empty: t('rempli', 'filled'),
  };
  const needsValue = (op: ContactFieldOp) => op === 'contains' || op === 'not_contains' || op === 'eq';

  return (
    <div className="space-y-3 rounded-2xl border border-ink-200 bg-white p-4 shadow-sm">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs text-ink-500">
          {t('Nom contient', 'Name contains')}
          <input value={filters.nameSearch ?? ''} onChange={(e) => set({ nameSearch: e.target.value || undefined })} className={inputCls} placeholder={t('ex. Marc', 'e.g. Marc')} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-500">
          {t('Consentement', 'Consent')}
          <select value={filters.optIn ?? ''} onChange={(e) => set({ optIn: (e.target.value || undefined) as ContactFilters['optIn'] })} className={`${inputCls} bg-white`}>
            <option value="">{t('tous', 'all')}</option>
            <option value="opted_in">opt-in</option>
            <option value="opted_out">opt-out</option>
            <option value="unknown">{t('inconnu', 'unknown')}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-500">
          Email
          <div className="flex gap-2">
            <select value={emailMode} onChange={(e) => setEmail(e.target.value as typeof emailMode)} className={`${inputCls} bg-white`}>
              <option value="">{t('tous', 'all')}</option>
              <option value="not_empty">{t('rempli', 'filled')}</option>
              <option value="empty">{t('vide', 'empty')}</option>
              <option value="eq">{t('valeur précise', 'exact value')}</option>
            </select>
            {emailMode === 'eq' && (
              <input value={emailRow?.value ?? ''} onChange={(e) => setEmail('eq', e.target.value)} className={`${inputCls} flex-1`} placeholder="jean@ex.fr" />
            )}
          </div>
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-500">
          {t('Téléphone commence par', 'Phone starts with')}
          <input value={filters.phonePrefix ?? ''} onChange={(e) => set({ phonePrefix: e.target.value || undefined })} className={inputCls} placeholder="+336" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-500">
          {t('Téléphone contient', 'Phone contains')}
          <input value={filters.phoneContains ?? ''} onChange={(e) => set({ phoneContains: e.target.value || undefined })} className={inputCls} placeholder="42 42" />
        </label>
      </div>

      {/* Tags possède (ET/OU) */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2 text-xs text-ink-500">
          {t('Possède les tags', 'Has tags')}
          <div className="inline-flex overflow-hidden rounded-md border border-ink-200">
            {(['and', 'or'] as const).map((m) => (
              <button key={m} type="button" onClick={() => set({ tagMode: m })} className={`px-2 py-0.5 text-xs ${(filters.tagMode ?? 'and') === m ? 'bg-brand-500 text-white' : 'bg-white text-ink-600'}`}>
                {m === 'and' ? t('tous', 'all') : t('au moins un', 'any')}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {tags.map((x) => (
            <span key={x} className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
              {x}<button type="button" onClick={() => rmTag(x)} className="text-brand-400 hover:text-coral">×</button>
            </span>
          ))}
          <input list="contact-filter-tags" value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(tagInput); } }} placeholder={t('+ tag', '+ tag')} className={`${inputCls} w-28`} />
        </div>
      </div>

      {/* Tags ne possède pas */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-ink-500">{t('Ne possède pas les tags', "Doesn't have tags")}</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {tagsExclude.map((x) => (
            <span key={x} className="inline-flex items-center gap-1 rounded-md bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-600">
              {x}<button type="button" onClick={() => rmTagEx(x)} className="text-ink-400 hover:text-coral">×</button>
            </span>
          ))}
          <input list="contact-filter-tags" value={tagExInput} onChange={(e) => setTagExInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTagEx(tagExInput); } }} placeholder={t('+ tag', '+ tag')} className={`${inputCls} w-28`} />
        </div>
      </div>
      <datalist id="contact-filter-tags">{tagSuggestions.map((tg) => <option key={tg} value={tg} />)}</datalist>

      {/* Filtres de champ perso (répétables, hors email) */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-ink-500">{t('Champs', 'Fields')}</span>
        {fieldRows.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <select value={r.key} onChange={(e) => updRow(i, { key: e.target.value })} className={`${inputCls} bg-white`}>
              {fieldKeys.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
            </select>
            <select value={r.op} onChange={(e) => updRow(i, { op: e.target.value as ContactFieldOp })} className={`${inputCls} bg-white`}>
              {(['contains', 'not_contains', 'eq', 'empty', 'not_empty'] as ContactFieldOp[]).map((op) => <option key={op} value={op}>{opLabels[op]}</option>)}
            </select>
            {needsValue(r.op) && <input value={r.value} onChange={(e) => updRow(i, { value: e.target.value })} className={`${inputCls} flex-1`} placeholder={t('valeur', 'value')} />}
            <button type="button" onClick={() => rmRow(i)} className="text-ink-400 hover:text-coral" aria-label={t('Retirer', 'Remove')}>×</button>
          </div>
        ))}
        {fieldRows.length < 5 && fieldKeys.length > 0 && (
          <button type="button" onClick={addRow} className="self-start text-sm font-medium text-brand-600 hover:text-brand-700">+ {t('Filtre de champ', 'Field filter')}</button>
        )}
      </div>

      <div className="flex justify-end border-t border-ink-100 pt-2">
        <button type="button" onClick={onClear} className="text-xs text-ink-500 hover:text-coral">{t('Réinitialiser les filtres', 'Reset filters')}</button>
      </div>
    </div>
  );
}
