'use client';

import { useT } from '@/lib/i18n';
import type { UserFieldDef, UserFieldKind } from '@/lib/api';

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
  | { kind: 'optin'; value: 'opted_in' | 'opted_out' | 'unknown' };
export interface ConditionGroup { match: 'all' | 'any'; clauses: Clause[] }

/** Champs de BASE adressables par une condition (attributs + socles). `wa_id` exclu : le moteur ne le résout pas. */
const BASE_FIELDS: { key: string; type: UserFieldKind }[] = [
  { key: 'name', type: 'text' }, { key: 'prenom', type: 'text' }, { key: 'email', type: 'text' },
  { key: 'phone', type: 'text' }, { key: 'bsuid', type: 'text' },
];
const BASE_LABELS: Record<string, [string, string]> = {
  name: ['Nom', 'Name'], prenom: ['Prénom', 'First name'], email: ['Email', 'Email'], phone: ['Téléphone', 'Phone'], bsuid: ['BSUID', 'BSUID'],
};

type Kind = 'field' | 'tag' | 'weekday' | 'business_hours' | 'time_of_day' | 'identity' | 'optin';
function kindOf(c: Clause): Kind {
  return c.kind === 'datetime' ? 'field' : (c.kind as Kind); // une clause sur un champ date/heure reste « Champ » dans l'UI
}

export function ConditionBuilder({ group, onChange, fields, tags }: {
  group: ConditionGroup;
  onChange: (g: ConditionGroup) => void;
  fields: UserFieldDef[];
  tags: string[];
}) {
  const t = useT();
  const clauses = Array.isArray(group.clauses) ? group.clauses : [];
  const match = group.match === 'any' ? 'any' : 'all';

  // Liste des champs adressables (base + perso), avec leur type -> détermine les opérateurs proposés.
  const allFields: { key: string; label: string; type: UserFieldKind }[] = [
    ...BASE_FIELDS.map((f) => ({ key: f.key, label: t(...(BASE_LABELS[f.key] ?? [f.key, f.key])), type: f.type })),
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
    else patch(i, defaultFieldClause(allFields[0]?.key ?? 'name', typeOfKey(allFields[0]?.key ?? 'name')));
  };
  // Changement de champ -> reconstruit une clause adaptée au TYPE du nouveau champ.
  const changeField = (i: number, key: string) => patch(i, defaultFieldClause(key, typeOfKey(key)));

  // `w-full min-w-0` : le panneau de configuration fait 280 px. Deux menus côte à côte n'y tiennent pas, et
  // les libellés (« Consentement (opt-in) », « est un jour de semaine (Lun-Ven) ») débordaient, l'un large,
  // l'autre écrasé. Chaque contrôle prend donc toute la largeur, empilé.
  const sel = 'w-full min-w-0 rounded-lg border border-ink-300 px-2 py-1.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 bg-white';
  const inp = 'w-full min-w-0 rounded-lg border border-ink-300 px-2 py-1.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

  return (
    <div className="space-y-2">
      {clauses.length > 1 && (
        // Empilé et non en ligne : la phrase et son menu ne tiennent pas côte à côte dans 280 px, et sans
        // `flex-wrap` la ligne débordait du panneau au lieu de passer à la ligne.
        <div className="space-y-1 text-xs text-ink-600">
          <span>{t('Le contact passe par « Si réunie » quand :', 'The contact takes “If met” when:')}</span>
          <select value={match} onChange={(e) => onChange({ match: e.target.value === 'any' ? 'any' : 'all', clauses })} className={`${sel} py-1`}>
            <option value="all">{t('toutes les conditions sont vraies', 'all conditions are true')}</option>
            <option value="any">{t('au moins une condition est vraie', 'at least one condition is true')}</option>
          </select>
        </div>
      )}

      {clauses.length === 0 && <p className="text-[11px] text-ink-400">{t('Aucune condition : le contact part toujours sur « Si réunie ».', 'No condition: the contact always takes “If met”.')}</p>}

      {clauses.map((c, i) => (
        <div key={i} className="rounded-xl border border-ink-100 bg-ink-50/40 p-2">
          <div className="flex items-start gap-1.5">
            {/* Colonne : chaque contrôle sur sa propre ligne, pleine largeur. `min-w-0` est indispensable,
                sinon un select à long libellé impose sa largeur naturelle et pousse la ligne hors du panneau. */}
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <select value={kindOf(c)} onChange={(e) => changeKind(i, e.target.value as Kind)} className={sel}>
                <option value="field">{t('Champ', 'Field')}</option>
                <option value="tag">{t('Tag', 'Tag')}</option>
                <option value="weekday">{t('Jour de la semaine', 'Day of week')}</option>
                <option value="business_hours">{t('Heures d’ouverture', 'Business hours')}</option>
                <option value="time_of_day">{t('Heure de la journée', 'Time of day')}</option>
                <option value="identity">{t('Coordonnées', 'Contact info')}</option>
                <option value="optin">{t('Consentement (opt-in)', 'Consent (opt-in)')}</option>
              </select>
              <ClauseOperands c={c} i={i} patch={patch} allFields={allFields} changeField={changeField} tags={tags} sel={sel} inp={inp} />
            </div>
            <button type="button" onClick={() => remove(i)} className="shrink-0 pt-1.5 text-ink-400 hover:text-coral" aria-label={t('Retirer', 'Remove')}>×</button>
          </div>
        </div>
      ))}

      <button type="button" onClick={add} className="text-xs text-brand-600 hover:underline">{t('+ ajouter une condition', '+ add a condition')}</button>
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
          <option value="has">{t('possède le tag', 'has the tag')}</option>
          <option value="not_has">{t('n’a pas le tag', 'does not have the tag')}</option>
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

  // Champ (field ou datetime selon le type). Sélecteur de champ commun.
  const fieldSelect = (
    <select value={c.key} onChange={(e) => changeField(i, e.target.value)} className={sel}>
      {allFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
    </select>
  );
  const type = allFields.find((f) => f.key === c.key)?.type ?? 'text';

  if (c.kind === 'datetime') {
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
        <button key={d} type="button" onClick={() => toggle(d)} className={`h-7 w-7 rounded-md text-xs font-semibold transition ${days.includes(d) ? 'bg-brand-500 text-white' : 'bg-ink-100 text-ink-500 hover:bg-ink-200'}`}>
          {t(...lbl)}
        </button>
      ))}
    </div>
  );
}
