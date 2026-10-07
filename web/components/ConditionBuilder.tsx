'use client';

import { useState } from 'react';
import { useLocale, useT } from '@/lib/i18n';
import type { UserFieldDef, UserFieldKind } from '@/lib/api';
import { SYSTEM_FIELDS } from '@/lib/fields';
import { Icone } from '@/components/Icone';
import { EditeurFiltreAnalyse } from '@/components/EditeurFiltreAnalyse';
import { estFiltreAnalyse, filtreAnalyseParDefaut, type ChampFiltrable } from '@/lib/champs-fiche';
import { useChampsFiltrables } from '@/lib/use-champs-filtrables';
import { nomDeLangue } from '@/lib/langue-nom';
import {
  MAX_FAMILLES, ecrireFamilles, famillesDeCondition, nomDeFamille, nouveauCodeDeFamille, poigneeDeFamille,
  type FamilleLike,
} from '@/lib/condition-familles';

// Types miroir (sous-ensemble v1) de src/workflow/conditions.ts. Le backend est défensif sur `data` opaque ;
// on ne produit ici que des clauses bien formées. `valueType:'number'` force la comparaison numérique (eq inclus).
type TimeUnit = 'minutes' | 'hours' | 'days';
export type Clause =
  | { kind: 'tag'; op: 'has' | 'not_has'; tag: string }
  | { kind: 'field'; key: string; op: string; value?: string; valueType?: 'number' }
  | { kind: 'datetime'; key: string; op: string; value?: string; amount?: number; unit?: TimeUnit }
  | { kind: 'weekday'; op: 'is_weekday' | 'is_weekend' | 'is_one_of'; days?: number[] }
  | { kind: 'business_hours'; op: 'within' | 'outside' }
  | { kind: 'time_of_day'; op: 'before' | 'after'; time: string }
  | { kind: 'identity'; op: 'has_phone' | 'has_bsuid' | 'has_email' }
  | { kind: 'optin'; value: 'opted_in' | 'opted_out' | 'unknown' }
  // Les champs SYSTÈME (RC5) : proposés dans la liste des champs, sous l'intitulé « Système ».
  | { kind: 'dernier_message_recu'; op: string; value?: string; amount?: number; unit?: TimeUnit }
  | { kind: 'langue_detectee'; op: 'is' | 'is_not' | 'empty' | 'not_empty'; value?: string }
  | { kind: 'pays'; op: 'is_one_of'; values: string[] };
export interface ConditionGroup { match: 'all' | 'any'; clauses: Clause[] }

/**
 * Les champs que la PLATEFORME connaît sans que le contact les ait saisis. Ils sont dans la liste des champs, sous
 * « Système », avec une valeur `systeme:<kind>` qu'aucune clé de champ ne peut porter (une clé n'a pas de « : »).
 */
const CHAMPS_SYSTEME: Array<{ kind: 'dernier_message_recu' | 'langue_detectee' | 'pays'; label: [string, string] }> = [
  { kind: 'dernier_message_recu', label: ['Dernier message reçu', 'Last message received'] },
  { kind: 'langue_detectee', label: ['Langue détectée', 'Detected language'] },
  { kind: 'pays', label: ['Pays de l’indicatif', 'Country of the dialling code'] },
];
const PREFIXE_SYSTEME = 'systeme:';
const estClauseSysteme = (c: Clause): c is Extract<Clause, { kind: 'dernier_message_recu' | 'langue_detectee' | 'pays' }> =>
  c.kind === 'dernier_message_recu' || c.kind === 'langue_detectee' || c.kind === 'pays';

/** La clause par défaut d'un champ système, choisie dans la liste des champs. */
function defaultSystemClause(kind: (typeof CHAMPS_SYSTEME)[number]['kind']): Clause {
  if (kind === 'dernier_message_recu') return { kind, op: 'older_than', amount: 7, unit: 'days' };
  if (kind === 'langue_detectee') return { kind, op: 'is', value: 'en' };
  return { kind: 'pays', op: 'is_one_of', values: ['FR'] };
}

/** Champs de BASE adressables par une condition (attributs + socles). `wa_id` exclu : le moteur ne le résout pas. */
const BASE_FIELDS: { key: string; type: UserFieldKind }[] = [
  { key: 'name', type: 'text' }, { key: 'prenom', type: 'text' }, { key: 'email', type: 'text' },
  { key: 'phone', type: 'text' }, { key: 'bsuid', type: 'text' },
];

type Kind = 'field' | 'analyse' | 'tag' | 'weekday' | 'business_hours' | 'time_of_day' | 'identity' | 'optin';
function kindOf(c: Clause, champsAnalyse: readonly ChampFiltrable[]): Kind {
  // Une clause « champ » sur la dernière analyse s'édite dans SA rubrique : c'est la même clause pour le moteur
  // (`src/workflow/conditions.ts` la reconnaît à sa clé), mais pas les mêmes opérateurs.
  if (c.kind === 'field' && estFiltreAnalyse(c, champsAnalyse)) return 'analyse';
  // Une clause sur un champ date/heure, ou sur un champ système, reste « Champ » dans l'UI.
  return c.kind === 'datetime' || estClauseSysteme(c) ? 'field' : (c.kind as Kind);
}

export function ConditionBuilder({ tenantId, group, onChange, fields, tags, nomSortie }: {
  /** L'espace : la rubrique « Dernière analyse » n'est offerte que si l'API décrit ses champs. */
  tenantId: string;
  group: ConditionGroup;
  onChange: (g: ConditionGroup) => void;
  fields: UserFieldDef[];
  tags: string[];
  /** Le nom de la sortie que ces clauses ouvrent, pour les phrases d'aide. Absent : « Si réunie ». */
  nomSortie?: string;
}) {
  const t = useT();
  const sortie = nomSortie ?? t('Si réunie', 'If met');
  const champsAnalyse = useChampsFiltrables(tenantId);
  const clauses = Array.isArray(group.clauses) ? group.clauses : [];
  const match = group.match === 'any' ? 'any' : 'all';

  // Liste des champs adressables (base + perso), avec leur type -> détermine les opérateurs proposés.
  const allFields: { key: string; label: string; type: UserFieldKind }[] = [
    // Libellés pris dans la source COMMUNE `SYSTEM_FIELDS` : ce composant en portait une copie, parce que
    // `fields.ts` ne donnait que le français. Il le donne dans les deux langues, la copie n'a plus lieu d'être.
    ...BASE_FIELDS.map((f) => ({ key: f.key, label: t(...(SYSTEM_FIELDS.find((s) => s.key === f.key)?.label ?? [f.key, f.key])), type: f.type })),
    ...fields.filter((f) => !BASE_FIELDS.some((b) => b.key === f.key)).map((f) => ({ key: f.key, label: f.label, type: f.type })),
  ];
  const typeOfKey = (key: string): UserFieldKind => allFields.find((f) => f.key === key)?.type ?? 'text';

  const setClauses = (next: Clause[]) => onChange({ match, clauses: next });
  const patch = (i: number, c: Clause) => setClauses(clauses.map((x, j) => (j === i ? c : x)));
  const remove = (i: number) => setClauses(clauses.filter((_, j) => j !== i));
  const add = () => setClauses([...clauses, { kind: 'field', key: allFields[0]?.key ?? 'name', op: 'contains', value: '' }]);

  // Passage d'un KIND à l'autre -> clause par défaut du nouveau kind.
  const changeKind = (i: number, k: Kind) => {
    if (k === 'tag') patch(i, { kind: 'tag', op: 'has', tag: '' });
    else if (k === 'weekday') patch(i, { kind: 'weekday', op: 'is_weekday' });
    else if (k === 'business_hours') patch(i, { kind: 'business_hours', op: 'within' });
    else if (k === 'time_of_day') patch(i, { kind: 'time_of_day', op: 'after', time: '09:00' });
    else if (k === 'identity') patch(i, { kind: 'identity', op: 'has_email' });
    else if (k === 'optin') patch(i, { kind: 'optin', value: 'opted_in' });
    else if (k === 'analyse' && champsAnalyse[0]) patch(i, { kind: 'field', ...filtreAnalyseParDefaut(champsAnalyse[0]) });
    else patch(i, defaultFieldClause(allFields[0]?.key ?? 'name', typeOfKey(allFields[0]?.key ?? 'name')));
  };
  // Changement de champ -> reconstruit une clause adaptée au TYPE du nouveau champ (ou au champ système choisi).
  const changeField = (i: number, key: string) => {
    const systeme = CHAMPS_SYSTEME.find((s) => `${PREFIXE_SYSTEME}${s.kind}` === key);
    patch(i, systeme ? defaultSystemClause(systeme.kind) : defaultFieldClause(key, typeOfKey(key)));
  };

  // `w-full min-w-0` : le panneau de configuration fait 280 px. Deux menus côte à côte n'y tiennent pas, et
  // les libellés (« Consentement (opt-in) », « est un jour de semaine (Lun-Ven) ») débordaient, l'un large,
  // l'autre écrasé. Chaque contrôle prend donc toute la largeur, empilé.
  const sel = 'w-full min-w-0 rounded-controle border border-ink-300 px-2 py-1.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 bg-white';
  const inp = 'w-full min-w-0 rounded-controle border border-ink-300 px-2 py-1.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

  return (
    <div className="space-y-2">
      {clauses.length > 1 && (
        // Empilé et non en ligne : la phrase et son menu ne tiennent pas côte à côte dans 280 px, et sans
        // `flex-wrap` la ligne débordait du panneau au lieu de passer à la ligne.
        <div className="space-y-1 text-xs text-ink-500">
          <span>{t(`Le contact passe par « ${sortie} » quand :`, `The contact takes “${sortie}” when:`)}</span>
          <select value={match} onChange={(e) => onChange({ match: e.target.value === 'any' ? 'any' : 'all', clauses })} className={`${sel} py-1`}>
            <option value="all">{t('toutes les conditions sont vraies', 'all conditions are true')}</option>
            <option value="any">{t('au moins une condition est vraie', 'at least one condition is true')}</option>
          </select>
        </div>
      )}

      {clauses.length === 0 && <p className="text-xs text-ink-500">{t(`Aucune condition : le contact part toujours sur « ${sortie} ».`, `No condition: the contact always takes “${sortie}”.`)}</p>}

      {clauses.map((c, i) => (
        <div key={i} className="rounded-carte border border-ink-100 bg-ink-50/40 p-2">
          <div className="flex items-start gap-1.5">
            {/* Colonne : chaque contrôle sur sa propre ligne, pleine largeur. `min-w-0` est indispensable,
                sinon un select à long libellé impose sa largeur naturelle et pousse la ligne hors du panneau. */}
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <select value={kindOf(c, champsAnalyse)} onChange={(e) => changeKind(i, e.target.value as Kind)} className={sel}>
                <option value="field">{t('Champ', 'Field')}</option>
                {(champsAnalyse.length > 0 || kindOf(c, champsAnalyse) === 'analyse') && <option value="analyse">{t('Dernière analyse', 'Latest analysis')}</option>}
                <option value="tag">{t('Étiquette', 'Tag')}</option>
                <option value="weekday">{t('Jour de la semaine', 'Day of week')}</option>
                <option value="business_hours">{t('Heures d’ouverture', 'Business hours')}</option>
                <option value="time_of_day">{t('Heure de la journée', 'Time of day')}</option>
                <option value="identity">{t('Coordonnées', 'Contact info')}</option>
                <option value="optin">{t('Consentement (opt-in)', 'Consent (opt-in)')}</option>
              </select>
              {kindOf(c, champsAnalyse) === 'analyse' && c.kind === 'field'
                ? <EditeurFiltreAnalyse champs={champsAnalyse} filtre={{ key: c.key, op: c.op, value: c.value ?? '' }} onChange={(f) => patch(i, { kind: 'field', ...f })} sel={sel} inp={inp} />
                : <ClauseOperands c={c} i={i} patch={patch} allFields={allFields} changeField={changeField} tags={tags} sel={sel} inp={inp} />}
            </div>
            <button type="button" onClick={() => remove(i)} className="shrink-0 pt-1.5 text-ink-400 hover:text-danger" aria-label={t('Retirer', 'Remove')}><Icone nom="fermer" taille="petite" /></button>
          </div>
        </div>
      ))}

      <button type="button" onClick={add} className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline"><Icone nom="ajouter" taille="petite" />{t('Ajouter une condition', 'Add a condition')}</button>
    </div>
  );
}

/** Clause « champ » par défaut selon le TYPE du champ (texte/nombre/booléen/date). */
function defaultFieldClause(key: string, type: UserFieldKind): Clause {
  if (type === 'number') return { kind: 'field', key, op: 'gte', value: '', valueType: 'number' };
  if (type === 'boolean') return { kind: 'field', key, op: 'is_true' };
  if (type === 'date' || type === 'datetime') return { kind: 'datetime', key, op: 'after', value: 'now' };
  return { kind: 'field', key, op: 'contains', value: '' };
}

function ClauseOperands({ c, i, patch, allFields, changeField, tags, sel, inp }: {
  c: Clause; i: number; patch: (i: number, c: Clause) => void;
  allFields: { key: string; label: string; type: UserFieldKind }[];
  changeField: (i: number, key: string) => void; tags: string[]; sel: string; inp: string;
}) {
  const t = useT();

  if (c.kind === 'tag') {
    return (
      <>
        <select value={c.op} onChange={(e) => patch(i, { ...c, op: e.target.value as 'has' | 'not_has' })} className={sel}>
          <option value="has">{t('possède l’étiquette', 'has the tag')}</option>
          <option value="not_has">{t('n’a pas l’étiquette', 'does not have the tag')}</option>
        </select>
        {/* Pas de `flex-1` : le conteneur est une COLONNE, il étirerait le champ en HAUTEUR. */}
        <input list="wf-tags" value={c.tag} onChange={(e) => patch(i, { ...c, tag: e.target.value })} className={inp} placeholder="vip…" />
        <datalist id="wf-tags">{tags.map((tg) => <option key={tg} value={tg} />)}</datalist>
      </>
    );
  }
  if (c.kind === 'weekday') {
    return (
      <>
        <select value={c.op} onChange={(e) => { const op = e.target.value as 'is_weekday' | 'is_weekend' | 'is_one_of'; patch(i, { kind: 'weekday', op, ...(op === 'is_one_of' ? { days: c.days ?? [] } : {}) }); }} className={sel}>
          <option value="is_weekday">{t('est un jour de semaine (Lun-Ven)', 'is a weekday (Mon-Fri)')}</option>
          <option value="is_weekend">{t('est un week-end (Sam-Dim)', 'is a weekend (Sat-Sun)')}</option>
          <option value="is_one_of">{t('est un de ces jours', 'is one of these days')}</option>
        </select>
        {c.op === 'is_one_of' && <WeekdayPicker days={c.days ?? []} onChange={(days) => patch(i, { kind: 'weekday', op: 'is_one_of', days })} />}
      </>
    );
  }
  if (c.kind === 'business_hours') {
    return (
      <select value={c.op} onChange={(e) => patch(i, { ...c, op: e.target.value as 'within' | 'outside' })} className={sel}>
        <option value="within">{t('pendant les heures d’ouverture', 'within business hours')}</option>
        <option value="outside">{t('en dehors des heures d’ouverture', 'outside business hours')}</option>
      </select>
    );
  }
  if (c.kind === 'time_of_day') {
    return (
      <>
        <select value={c.op} onChange={(e) => patch(i, { ...c, op: e.target.value as 'before' | 'after' })} className={sel}>
          <option value="after">{t('après', 'after')}</option>
          <option value="before">{t('avant', 'before')}</option>
        </select>
        <input type="time" value={c.time} onChange={(e) => patch(i, { ...c, time: e.target.value })} className={inp} />
      </>
    );
  }
  if (c.kind === 'identity') {
    return (
      <select value={c.op} onChange={(e) => patch(i, { ...c, op: e.target.value as 'has_phone' | 'has_bsuid' | 'has_email' })} className={sel}>
        <option value="has_phone">{t('a un numéro de téléphone', 'has a phone number')}</option>
        <option value="has_email">{t('a un email', 'has an email')}</option>
        <option value="has_bsuid">{t('a un identifiant WhatsApp (BSUID)', 'has a WhatsApp id (BSUID)')}</option>
      </select>
    );
  }
  if (c.kind === 'optin') {
    return (
      <select value={c.value} onChange={(e) => patch(i, { ...c, value: e.target.value as 'opted_in' | 'opted_out' | 'unknown' })} className={sel}>
        <option value="opted_in">{t('a donné son consentement', 'has opted in')}</option>
        <option value="opted_out">{t('a refusé (opt-out)', 'has opted out')}</option>
        <option value="unknown">{t('consentement inconnu', 'consent unknown')}</option>
      </select>
    );
  }

  // Champ (field ou datetime selon le type, ou champ système). Sélecteur de champ commun : les champs de la fiche,
  // puis, sous « Système », ce que la plateforme sait du contact.
  const fieldSelect = (
    <select
      data-testid="condition-champ"
      value={estClauseSysteme(c) ? `${PREFIXE_SYSTEME}${c.kind}` : c.key}
      onChange={(e) => changeField(i, e.target.value)}
      className={sel}
    >
      {allFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
      <optgroup label={t('Système', 'System')}>
        {CHAMPS_SYSTEME.map((s) => <option key={s.kind} value={`${PREFIXE_SYSTEME}${s.kind}`}>{t(...s.label)}</option>)}
      </optgroup>
    </select>
  );

  if (c.kind === 'langue_detectee') {
    const avecValeur = c.op === 'is' || c.op === 'is_not';
    return (
      <>
        {fieldSelect}
        <select value={c.op} onChange={(e) => patch(i, { ...c, op: e.target.value as 'is' | 'is_not' | 'empty' | 'not_empty' })} className={sel}>
          <option value="is">{t('est', 'is')}</option>
          <option value="is_not">{t('n’est pas', 'is not')}</option>
          <option value="not_empty">{t('est connue', 'is known')}</option>
          <option value="empty">{t('est inconnue', 'is unknown')}</option>
        </select>
        {avecValeur && <SaisieLangue valeur={c.value ?? ''} onChange={(v) => patch(i, { ...c, value: v })} inp={inp} />}
      </>
    );
  }
  if (c.kind === 'pays') {
    return (
      <>
        {fieldSelect}
        <SaisiePays valeurs={c.values} onChange={(values) => patch(i, { ...c, values })} inp={inp} />
      </>
    );
  }

  const type = c.kind === 'field' || c.kind === 'datetime' ? (allFields.find((f) => f.key === c.key)?.type ?? 'text') : 'text';

  if (c.kind === 'datetime' || c.kind === 'dernier_message_recu') {
    const needsBase = c.op === 'before' || c.op === 'after';
    const needsRel = c.op === 'older_than' || c.op === 'newer_than';
    const isNow = c.value === 'now' || c.value === undefined;
    return (
      <>
        {fieldSelect}
        <select value={c.op} onChange={(e) => { const op = e.target.value; const rel = op === 'older_than' || op === 'newer_than'; patch(i, { ...c, op, ...(rel ? { unit: c.unit ?? 'days', amount: c.amount ?? 1 } : {}) }); }} className={sel}>
          <option value="after">{t('est après', 'is after')}</option>
          <option value="before">{t('est avant', 'is before')}</option>
          <option value="older_than">{t('remonte à plus de', 'is older than')}</option>
          <option value="newer_than">{t('remonte à moins de', 'is newer than')}</option>
          <option value="not_empty">{t('est renseignée', 'is set')}</option>
          <option value="empty">{t('est vide', 'is empty')}</option>
        </select>
        {needsBase && (
          <>
            <select value={isNow ? 'now' : 'fixed'} onChange={(e) => patch(i, { ...c, value: e.target.value === 'now' ? 'now' : '' })} className={sel}>
              <option value="now">{t('maintenant', 'now')}</option>
              <option value="fixed">{t('une date fixe', 'a fixed date')}</option>
            </select>
            {!isNow && <input type="datetime-local" value={c.value ?? ''} onChange={(e) => patch(i, { ...c, value: e.target.value })} className={inp} />}
          </>
        )}
        {needsRel && (
          // « 7 » + « jours » se lisent ensemble : c'est la seule paire qui reste sur une ligne. La largeur est
          // portée par les conteneurs, pas par une classe ajoutée à `inp` (deux utilitaires de largeur sur le
          // même élément se départagent par l'ordre de la feuille de style, pas par l'ordre des classes).
          <div className="flex gap-1.5">
            <div className="w-20 shrink-0">
              <input type="number" min={0} value={c.amount ?? ''} onChange={(e) => patch(i, { ...c, amount: e.target.value === '' ? undefined : Number(e.target.value) })} className={inp} placeholder="7" />
            </div>
            <div className="min-w-0 flex-1">
              <select value={c.unit ?? 'days'} onChange={(e) => patch(i, { ...c, unit: e.target.value as TimeUnit })} className={sel}>
                <option value="minutes">{t('minutes', 'minutes')}</option>
                <option value="hours">{t('heures', 'hours')}</option>
                <option value="days">{t('jours', 'days')}</option>
              </select>
            </div>
          </div>
        )}
      </>
    );
  }

  // Clause field : texte / nombre / booléen.
  if (type === 'boolean') {
    return (
      <>
        {fieldSelect}
        <select value={c.op} onChange={(e) => patch(i, { kind: 'field', key: c.key, op: e.target.value })} className={sel}>
          <option value="is_true">{t('est vrai (oui)', 'is true (yes)')}</option>
          <option value="is_false">{t('est faux (non)', 'is false (no)')}</option>
        </select>
      </>
    );
  }
  const isNumber = type === 'number';
  const needsValue = c.op === 'eq' || c.op === 'neq' || c.op === 'contains' || c.op === 'not_contains' || c.op === 'lt' || c.op === 'lte' || c.op === 'gt' || c.op === 'gte';
  return (
    <>
      {fieldSelect}
      <select
        value={c.op}
        onChange={(e) => patch(i, { kind: 'field', key: c.key, op: e.target.value, ...(isNumber ? { valueType: 'number' as const } : {}), value: (c as { value?: string }).value ?? '' })}
        className={sel}
      >
        {isNumber ? (
          <>
            <option value="eq">{t('égal à', 'equals')}</option>
            <option value="neq">{t('différent de', 'not equal to')}</option>
            <option value="lt">{'<'}</option>
            <option value="lte">{'≤'}</option>
            <option value="gt">{'>'}</option>
            <option value="gte">{'≥'}</option>
            <option value="not_empty">{t('est renseigné', 'is set')}</option>
            <option value="empty">{t('est vide', 'is empty')}</option>
          </>
        ) : (
          <>
            <option value="contains">{t('contient', 'contains')}</option>
            <option value="not_contains">{t('ne contient pas', 'does not contain')}</option>
            <option value="eq">{t('est exactement', 'is exactly')}</option>
            <option value="not_empty">{t('est renseigné', 'is set')}</option>
            <option value="empty">{t('est vide', 'is empty')}</option>
          </>
        )}
      </select>
      {needsValue && (
        <input
          type={isNumber ? 'number' : 'text'}
          value={(c as { value?: string }).value ?? ''}
          onChange={(e) => patch(i, { kind: 'field', key: c.key, op: c.op, ...(isNumber ? { valueType: 'number' as const } : {}), value: e.target.value })}
          className={inp}
          placeholder={t('valeur', 'value')}
        />
      )}
    </>
  );
}

/** Les langues proposées d'office : celles qu'on rencontre le plus. Toute autre se tape (code ISO 639-1). */
const LANGUES_COURANTES = ['fr', 'en', 'es', 'de', 'it', 'pt', 'nl', 'ar'];

/**
 * La langue à comparer, par son code ISO 639-1 (c'est ce que la traduction apprend), avec son nom en clair à côté pour
 * qu'on sache ce qu'on a tapé.
 */
function SaisieLangue({ valeur, onChange, inp }: { valeur: string; onChange: (v: string) => void; inp: string }) {
  const t = useT();
  const { locale } = useLocale();
  const nom = nomDeLangue(valeur, locale);
  return (
    <div className="space-y-1">
      <input
        data-testid="condition-langue"
        list="wf-langues"
        value={valeur}
        onChange={(e) => onChange(e.target.value.trim().toLowerCase())}
        className={inp}
        placeholder="en"
      />
      <datalist id="wf-langues">{LANGUES_COURANTES.map((l) => <option key={l} value={l}>{nomDeLangue(l, locale)}</option>)}</datalist>
      <p className="text-xs text-ink-500">
        {valeur.trim() === ''
          ? t('Code de langue à deux lettres (en, es, de…).', 'Two-letter language code (en, es, de…).')
          : `${nom} · ${t('apprise des messages du contact, inconnue tant qu’aucun n’a été traduit', 'learnt from the contact’s messages, unknown until one is translated')}`}
      </p>
    </div>
  );
}

/** Le nom d'un pays dans la langue de la console, ou son code si le navigateur ne le connaît pas. */
function nomDePays(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Les pays retenus, en codes à deux lettres séparés par des virgules (la même saisie que le ciblage d'une
 * publicité). Le texte tapé vit dans un état LOCAL : relu depuis la liste à chaque frappe, « FR, » perdrait sa
 * virgule avant qu'on ait tapé le pays suivant.
 */
function SaisiePays({ valeurs, onChange, inp }: { valeurs: string[]; onChange: (v: string[]) => void; inp: string }) {
  const t = useT();
  const { locale } = useLocale();
  const lire = (s: string): string[] => s.split(',').map((p) => p.trim().toUpperCase()).filter((p) => /^[A-Z]{2}$/.test(p));
  const codes = (Array.isArray(valeurs) ? valeurs : []).filter((v) => /^[A-Z]{2}$/.test(v));
  const [brut, setBrut] = useState(() => codes.join(', '));
  // Le texte tapé tant qu'il dit la même liste que la clause ; sinon (clause voisine retirée, bloc rechargé) la liste.
  const affiche = lire(brut).join(',') === codes.join(',') ? brut : codes.join(', ');
  return (
    <div className="space-y-1">
      <input
        data-testid="condition-pays"
        value={affiche}
        onChange={(e) => {
          setBrut(e.target.value);
          onChange(lire(e.target.value));
        }}
        className={inp}
        placeholder="FR, BE, CH"
      />
      <p className="text-xs text-ink-500">
        {codes.length === 0
          ? t('Codes pays à deux lettres, séparés par des virgules. Le pays se déduit du numéro du contact.', 'Two-letter country codes, comma-separated. The country comes from the contact’s number.')
          : `${t('est l’un de', 'is one of')} : ${codes.map((c) => nomDePays(c, locale)).join(', ')}`}
      </p>
    </div>
  );
}

/**
 * LES FAMILLES D'UN BLOC CONDITION (RC5). Chaque famille a son nom (affiché sur sa sortie) et ses propres clauses en
 * ET ou en OU ; le contact suit la PREMIÈRE vraie, de haut en bas, sinon « Sinon », fixe en bas.
 *
 * 🔴 RETIRER UNE FAMILLE EMPORTE SON ARÊTE, ET AUCUNE AUTRE. Ce panneau ne voit pas les arêtes : il annonce au
 * constructeur les poignées qui RESTENT (`wf-condition-familles`, même contrat que `wf-agent-change`), et le
 * constructeur retire celles d'une famille disparue. Les autres familles gardent leur poignée, tirée de leur code
 * et non de leur place : ni le retrait ni le réordonnancement ne décrochent une flèche.
 */
export function EditeurFamilles({ tenantId, nodeId, data, onPatch, fields, tags }: {
  tenantId: string;
  nodeId: string;
  data: Record<string, unknown>;
  onPatch: (p: Record<string, unknown>) => void;
  fields: UserFieldDef[];
  tags: string[];
}) {
  const t = useT();
  const { locale } = useLocale();
  const familles = famillesDeCondition(data);
  const ecrire = (next: FamilleLike[]) => onPatch(ecrireFamilles(next));
  const changer = (i: number, p: Partial<FamilleLike>) => ecrire(familles.map((f, j) => (j === i ? { ...f, ...p } : f)));
  const deplacer = (i: number, vers: number) => {
    const next = [...familles];
    const [f] = next.splice(i, 1);
    next.splice(vers, 0, f!);
    ecrire(next);
  };
  const retirer = (i: number) => {
    const next = familles.filter((_, j) => j !== i);
    ecrire(next);
    window.dispatchEvent(new CustomEvent('wf-condition-familles', {
      detail: { nodeId, poignees: next.map((f) => poigneeDeFamille(f.code)) },
    }));
  };
  const ajouter = () => ecrire([
    ...familles,
    { code: nouveauCodeDeFamille(familles.map((f) => f.code)), nom: '', groupe: { match: 'all', clauses: [] } },
  ]);
  const bouton = 'nodrag shrink-0 rounded-controle p-1 text-ink-400 hover:text-ink-900 disabled:cursor-not-allowed disabled:opacity-30';

  return (
    <div className="space-y-2">
      <p className="text-xs text-ink-500">
        {t('Le contact suit la première famille vraie, de haut en bas. Si aucune ne l’est, il part sur « Sinon ».',
          'The contact takes the first group that is true, top to bottom. If none is, they take “Otherwise”.')}
      </p>
      {familles.map((f, i) => {
        const nom = nomDeFamille(f, i, locale);
        return (
          <div key={f.code} data-testid={`famille-${i}`} className="space-y-2 rounded-carte border border-ink-200 p-2">
            <div className="flex items-center gap-1">
              <input
                data-testid={`famille-nom-${i}`}
                value={f.nom}
                maxLength={40}
                onChange={(e) => changer(i, { nom: e.target.value })}
                placeholder={nom}
                aria-label={t('Nom de la famille', 'Group name')}
                className="w-full min-w-0 rounded-controle border border-ink-300 px-2 py-1 text-sm font-medium outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              />
              <button type="button" data-testid={`famille-monter-${i}`} disabled={i === 0} onClick={() => deplacer(i, i - 1)} className={bouton} aria-label={t('Monter', 'Move up')} title={t('Monter', 'Move up')}>
                <Icone nom="deplier" taille="petite" className="rotate-180" />
              </button>
              <button type="button" data-testid={`famille-descendre-${i}`} disabled={i === familles.length - 1} onClick={() => deplacer(i, i + 1)} className={bouton} aria-label={t('Descendre', 'Move down')} title={t('Descendre', 'Move down')}>
                <Icone nom="deplier" taille="petite" />
              </button>
              {/* La dernière famille ne se retire pas : un bloc sans famille enverrait tout le monde sur « Sinon ». */}
              <button type="button" data-testid={`famille-retirer-${i}`} disabled={familles.length === 1} onClick={() => retirer(i)} className={`${bouton} hover:text-danger`} aria-label={t('Retirer la famille', 'Remove the group')} title={t('Retirer la famille', 'Remove the group')}>
                <Icone nom="fermer" taille="petite" />
              </button>
            </div>
            <ConditionBuilder
              tenantId={tenantId}
              group={f.groupe as ConditionGroup}
              onChange={(g) => changer(i, { groupe: g })}
              fields={fields}
              tags={tags}
              nomSortie={nom}
            />
          </div>
        );
      })}
      {familles.length < MAX_FAMILLES && (
        <button type="button" data-testid="famille-ajouter" onClick={ajouter} className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline">
          <Icone nom="ajouter" taille="petite" />{t('Ajouter une famille', 'Add a group')}
        </button>
      )}
      <div data-testid="famille-sinon" className="rounded-carte border border-ink-200 bg-ink-50 px-2 py-1.5 text-xs text-ink-500">
        <span className="font-medium text-danger">{t('Sinon', 'Otherwise')}</span>
        {' : '}{t('aucune famille n’est vraie.', 'no group is true.')}
      </div>
    </div>
  );
}

/** Sélecteur multi-jours pour weekday.is_one_of. Valeurs 0=dimanche..6=samedi (convention moteur) ; affichage Lun->Dim. */
function WeekdayPicker({ days, onChange }: { days: number[]; onChange: (d: number[]) => void }) {
  const t = useT();
  const DAYS: [number, [string, string]][] = [
    [1, ['L', 'M']], [2, ['M', 'T']], [3, ['M', 'W']], [4, ['J', 'T']], [5, ['V', 'F']], [6, ['S', 'S']], [0, ['D', 'S']],
  ];
  const toggle = (d: number) => onChange(days.includes(d) ? days.filter((x) => x !== d) : [...days, d]);
  return (
    <div className="flex flex-wrap gap-1">
      {DAYS.map(([d, lbl]) => (
        <button key={d} type="button" onClick={() => toggle(d)} className={`h-7 w-7 rounded-controle text-xs font-semibold transition-colors duration-150 ${days.includes(d) ? 'bg-brand-600 text-white' : 'bg-ink-100 text-ink-500 hover:bg-ink-200'}`}>
          {t(...lbl)}
        </button>
      ))}
    </div>
  );
}
