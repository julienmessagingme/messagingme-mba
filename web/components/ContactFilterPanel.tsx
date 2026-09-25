'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import type { ContactFilters, ContactFieldFilter, ContactFieldOp, UserFieldDef } from '@/lib/api';
import { inputClsAuto } from '@/lib/ui';
import { BADGE_NIVEAU_RISQUE, NIVEAUX_DU_FILTRE, apiConnaitLeRisque, estNiveauRisque } from '@/lib/risque';
import { Icone } from '@/components/Icone';

/**
 * Panneau de filtres de contacts, CONTRÔLÉ (édite un ContactFilters via onChange). Partagé par le mini-CRM
 * (écran Contacts) ET par la sélection de destinataires d'une campagne : une seule implémentation, pas deux
 * moteurs de recherche parallèles qui divergent. La sérialisation (filtersToQuery) et le parse serveur
 * (parseFilters / normalizeContactFilters) partagent déjà le même format ; ce composant est le miroir UI.
 *
 * Filtres : nom, opt-in, joignabilité, niveau de risque de désengagement, téléphone (commence par / contient),
 * tags (possède ET/OU + ne possède pas), champs perso répétables (contient / ne contient pas / égal / vide /
 * rempli), et un contrôle Email dédié.
 */
export function ContactFilterPanel({ filters, onChange, userFields, tagSuggestions, onClear, lignes }: {
  filters: ContactFilters;
  onChange: (f: ContactFilters) => void;
  userFields: UserFieldDef[];
  tagSuggestions: string[];
  onClear: () => void;
  /**
   * Les lignes que l'écran vient de recevoir de `/contacts`. REQUISES : elles seules disent si l'API connaît le
   * filtre du risque (`apiConnaitLeRisque`), et un écran qui oublierait de les passer ne le proposerait jamais,
   * plutôt que de le proposer à une API qui l'ignorerait.
   */
  lignes: readonly unknown[];
}) {
  const t = useT();
  /**
   * 🔴 LE FILTRE DU RISQUE N'EST OFFERT QUE SI L'API A MONTRÉ QU'ELLE LE CONNAÎT (relecture du lot 7). Une API qui
   * l'ignore rendrait tout l'espace à qui demande « élevé ». ACQUIS, jamais perdu : une recherche qui ne rend
   * aucune ligne ne doit pas faire disparaître le sélecteur. Et un filtre déjà POSÉ (brouillon de campagne repris)
   * reste toujours visible, pour qu'on le voie et qu'on puisse le retirer.
   */
  const [risqueConnu, setRisqueConnu] = useState(() => apiConnaitLeRisque(lignes));
  useEffect(() => {
    if (!risqueConnu && apiConnaitLeRisque(lignes)) setRisqueConnu(true);
  }, [lignes, risqueConnu]);
  const montrerRisque = risqueConnu || filters.risque !== undefined;
  const [tagInput, setTagInput] = useState('');
  const [tagExInput, setTagExInput] = useState('');
  const set = (patch: Partial<ContactFilters>) => onChange({ ...filters, ...patch });

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
    <div className="space-y-3 rounded-carte border border-ink-200 bg-white p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs text-ink-500">
          {t('Nom contient', 'Name contains')}
          <input value={filters.nameSearch ?? ''} onChange={(e) => set({ nameSearch: e.target.value || undefined })} className={inputClsAuto} placeholder={t('ex. Marc', 'e.g. Marc')} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-500">
          {t('Consentement', 'Consent')}
          <select value={filters.optIn ?? ''} onChange={(e) => set({ optIn: (e.target.value || undefined) as ContactFilters['optIn'] })} className={`${inputClsAuto} bg-white`}>
            <option value="">{t('tous', 'all')}</option>
            <option value="opted_in">opt-in</option>
            <option value="opted_out">opt-out</option>
            <option value="unknown">{t('inconnu', 'unknown')}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-500">
          Email
          <div className="flex gap-2">
            <select value={emailMode} onChange={(e) => setEmail(e.target.value as typeof emailMode)} className={`${inputClsAuto} bg-white`}>
              <option value="">{t('tous', 'all')}</option>
              <option value="not_empty">{t('rempli', 'filled')}</option>
              <option value="empty">{t('vide', 'empty')}</option>
              <option value="eq">{t('valeur précise', 'exact value')}</option>
            </select>
            {emailMode === 'eq' && (
              <input value={emailRow?.value ?? ''} onChange={(e) => setEmail('eq', e.target.value)} className={`${inputClsAuto} flex-1`} placeholder="jean@ex.fr" />
            )}
          </div>
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-500">
          {t('Joignabilité WhatsApp', 'WhatsApp reachability')}
          {/* ⚠️ DEUX CHOIX, PAS TROIS. Il n'y a pas de « seulement les joignables » : ce serait exclure tout
              le parc jamais sollicité, c'est-à-dire l'inverse de ce qu'un opérateur croit demander. La seule
              question utile est « écarte ceux qu'on SAIT injoignables », et elle laisse passer les inconnus. */}
          <select
            value={filters.joignabiliteWhatsApp ?? ''}
            onChange={(e) => set({ joignabiliteWhatsApp: e.target.value === 'connu_injoignable' ? 'connu_injoignable' : undefined })}
            className={`${inputClsAuto} bg-white`}
            data-testid="filtre-joignabilite"
          >
            <option value="">{t('tous', 'all')}</option>
            <option value="connu_injoignable">{t('sauf les injoignables connus', 'except known unreachable')}</option>
          </select>
        </label>
        {montrerRisque && <label className="flex flex-col gap-1 text-xs text-ink-500">
          {t('Risque de désengagement', 'Disengagement risk')}
          {/* Le niveau CALCULÉ chaque nuit. ⚠️ Une fiche jamais calculée n'est dans aucun niveau, « inconnu »
              compris : « inconnu » est un calcul qui n'a rien pu observer (rien de délivré sur 90 jours). Le
              choix part tel quel au serveur, qui refuse une valeur hors des quatre niveaux au lieu de l'ignorer. */}
          <select
            value={filters.risque ?? ''}
            onChange={(e) => set({ risque: estNiveauRisque(e.target.value) ? e.target.value : undefined })}
            className={`${inputClsAuto} bg-white`}
            data-testid="filtre-risque"
          >
            <option value="">{t('tous', 'all')}</option>
            {NIVEAUX_DU_FILTRE.map((n) => (
              <option key={n} value={n}>
                {n === 'inconnu' ? t('inconnu (rien de délivré sur 90 jours)', 'unknown (nothing delivered in 90 days)') : t(...BADGE_NIVEAU_RISQUE[n].text)}
              </option>
            ))}
          </select>
        </label>}
        <label className="flex flex-col gap-1 text-xs text-ink-500">
          {t('Téléphone commence par', 'Phone starts with')}
          <input value={filters.phonePrefix ?? ''} onChange={(e) => set({ phonePrefix: e.target.value || undefined })} className={inputClsAuto} placeholder="+336" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-500">
          {t('Téléphone contient', 'Phone contains')}
          <input value={filters.phoneContains ?? ''} onChange={(e) => set({ phoneContains: e.target.value || undefined })} className={inputClsAuto} placeholder="42 42" />
        </label>
      </div>

      {/* Tags possède (ET/OU) */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2 text-xs text-ink-500">
          {t('Possède les étiquettes', 'Has tags')}
          <div className="inline-flex overflow-hidden rounded-controle border border-ink-200">
            {(['and', 'or'] as const).map((m) => (
              <button key={m} type="button" onClick={() => set({ tagMode: m })} className={`px-2 py-0.5 text-xs ${(filters.tagMode ?? 'and') === m ? 'bg-brand-600 text-white' : 'bg-white text-ink-500 hover:bg-ink-50'}`}>
                {m === 'and' ? t('tous', 'all') : t('au moins un', 'any')}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {tags.map((x) => (
            <span key={x} className="inline-flex items-center gap-1 rounded-controle bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
              {x}<button type="button" onClick={() => rmTag(x)} aria-label={t('Retirer', 'Remove')} className="text-brand-600 hover:text-danger"><Icone nom="fermer" taille="petite" /></button>
            </span>
          ))}
          <input list="contact-filter-tags" value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(tagInput); } }} placeholder={t('+ étiquette', '+ tag')} className={`${inputClsAuto} w-28`} />
        </div>
      </div>

      {/* Tags ne possède pas */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-ink-500">{t('Ne possède pas les étiquettes', "Doesn't have tags")}</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {tagsExclude.map((x) => (
            <span key={x} className="inline-flex items-center gap-1 rounded-controle bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-500">
              {x}<button type="button" onClick={() => rmTagEx(x)} aria-label={t('Retirer', 'Remove')} className="text-ink-400 hover:text-danger"><Icone nom="fermer" taille="petite" /></button>
            </span>
          ))}
          <input list="contact-filter-tags" value={tagExInput} onChange={(e) => setTagExInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTagEx(tagExInput); } }} placeholder={t('+ étiquette', '+ tag')} className={`${inputClsAuto} w-28`} />
        </div>
      </div>
      <datalist id="contact-filter-tags">{tagSuggestions.map((tg) => <option key={tg} value={tg} />)}</datalist>

      {/* Filtres de champ perso (répétables, hors email) */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-ink-500">{t('Champs', 'Fields')}</span>
        {fieldRows.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <select value={r.key} onChange={(e) => updRow(i, { key: e.target.value })} className={`${inputClsAuto} bg-white`}>
              {fieldKeys.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
            </select>
            <select value={r.op} onChange={(e) => updRow(i, { op: e.target.value as ContactFieldOp })} className={`${inputClsAuto} bg-white`}>
              {(['contains', 'not_contains', 'eq', 'empty', 'not_empty'] as ContactFieldOp[]).map((op) => <option key={op} value={op}>{opLabels[op]}</option>)}
            </select>
            {needsValue(r.op) && <input value={r.value} onChange={(e) => updRow(i, { value: e.target.value })} className={`${inputClsAuto} flex-1`} placeholder={t('valeur', 'value')} />}
            <button type="button" onClick={() => rmRow(i)} className="text-ink-400 hover:text-danger" aria-label={t('Retirer', 'Remove')}><Icone nom="fermer" taille="petite" /></button>
          </div>
        ))}
        {fieldRows.length < 5 && fieldKeys.length > 0 && (
          <button type="button" onClick={addRow} className="self-start text-sm font-medium text-brand-600 hover:text-brand-700">+ {t('Filtre de champ', 'Field filter')}</button>
        )}
      </div>

      <div className="flex justify-end border-t border-ink-100 pt-2">
        <button type="button" onClick={onClear} className="text-xs text-ink-500 hover:text-danger">{t('Réinitialiser les filtres', 'Reset filters')}</button>
      </div>
    </div>
  );
}
