'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { VariableBodyEditor, type VariableBodyEditorHandle } from '@/components/VariableBodyEditor';
import { listUserFields, type UserFieldDef, type ParamSource, type TemplateParamHint } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { SYSTEM_FIELDS, customFieldsOnly, systemFieldExample } from '@/lib/fields';
import { inputCls } from '@/lib/ui';

/**
 * Le corps d'un template avec ses VARIABLES : éditeur à chips, sélecteur de champ, emojis, exemples exigés
 * par Meta, indices « variable -> champ », et canonicalisation des positions au moment d'envoyer.
 *
 * Extrait de TemplateForm pour que le CAROUSEL en hérite à l'identique : son message d'introduction est un
 * corps de template comme un autre (même composant Meta BODY, mêmes `example.body_text`, mêmes hints, même
 * résolution à l'envoi). Deux implémentations auraient divergé au premier correctif.
 */

// Emojis courants pour messages business (insérés au curseur dans le corps).
const EMOJIS = [
  '😀','😊','😉','😍','🥳','🤩','😎','🙌','👋','👍','🙏','🤝','💪','👏','🔥','✨',
  '⭐','🌟','💯','✅','✔️','☑️','❌','⚡','🎉','🎊','🎁','🎈','🥂','🍾','❤️','🧡',
  '💛','💚','💙','💜','💖','💥','💡','📣','📢','🔔','📅','⏰','🕐','⌛','📍','📌',
  '🏷️','🛍️','🛒','💳','💰','🤑','📦','🚚','🚀','🎯','📈','📊','💬','💭','📞','📲',
  '✉️','📧','📝','🔗','➡️','👉','👀','🤗',
];

/** Une variable {{n}} rattachée à un champ (via le sélecteur) : source (pour l'indice) + libellé (chip). */
export interface VarSource { source: ParamSource; label: string }

/** Exemple déterministe (jamais vide) exigé par Meta, selon le champ choisi. Zéro IA : valeur plausible par
 *  clé connue, sinon par type de champ. */
export function deterministicExample(source: ParamSource, fieldType?: string): string {
  if (source.type === 'now') return '31/12/2026'; // date du jour (JJ/MM/AAAA), exemple Meta déterministe
  // Champ de base (attribut) : exemple propre par clé (Nom, Téléphone, BSUID, WhatsApp ID) via la source commune.
  if (source.type === 'attribute') return systemFieldExample(source.key ?? '');
  if (source.type === 'literal') return source.value?.trim() || 'exemple';
  const key = (source.key ?? '').toLowerCase();
  const byKey: Record<string, string> = {
    prenom: 'Marie', firstname: 'Marie', nom: 'Martin', lastname: 'Martin',
    email: 'marie@exemple.fr', mail: 'marie@exemple.fr', ville: 'Lyon', city: 'Lyon',
    societe: 'Dupont SARL', entreprise: 'Dupont SARL', company: 'Dupont SARL',
    telephone: '+33 6 12 34 56 78', tel: '+33 6 12 34 56 78',
  };
  if (byKey[key]) return byKey[key]!;
  switch (fieldType) {
    case 'number': return '42';
    case 'date': return '2026-01-15';
    case 'url': return 'https://exemple.fr';
    case 'boolean': return 'oui';
    default: return 'Marie';
  }
}

/** Libellé lisible d'une source (pour le chip d'aperçu + restauration à l'édition). Aligné sur la source commune
 *  SYSTEM_FIELDS (mêmes libellés que la campagne) : un attribut bsuid/wa_id n'est plus mal étiqueté « Nom ». */
export function labelForSource(source: ParamSource, fields: UserFieldDef[], t: (fr: string, en?: string) => string): string {
  if (source.type === 'now') return t('Date du jour (auto)', "Today's date (auto)");
  if (source.type === 'literal') return t('Texte fixe', 'Fixed text');
  const sys = SYSTEM_FIELDS.find((f) => f.source.type === source.type && f.source.key === source.key);
  if (sys) return t(...sys.label);
  return fields.find((f) => f.key === source.key)?.label ?? source.key ?? t('Champ', 'Field');
}

/** Sélecteur d'emojis : insère au curseur, se ferme au clic extérieur. */
function EmojiPicker({ onPick, onClose }: { onPick: (e: string) => void; onClose: () => void }) {
  const t = useT();
  return (
    <>
      <button type="button" aria-label={t('Fermer', 'Close')} className="fixed inset-0 z-40 cursor-default" onClick={onClose} />
      <div className="absolute bottom-11 right-0 z-50 w-64 rounded-xl border border-ink-200 bg-white p-2 shadow-lg">
        <div className="grid grid-cols-8 gap-0.5">
          {EMOJIS.map((e) => (
            <button type="button" key={e} onClick={() => onPick(e)} className="rounded p-1 text-lg leading-none hover:bg-ink-100" aria-label={e}>
              {e}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/** Une option du sélecteur de variable : champ de BASE (group 'base') ou champ perso (group 'custom'). */
interface FieldOption { source: ParamSource; label: string; fieldType?: string; group: 'base' | 'custom' }

/** Sélecteur de champ : insère une variable rattachée au champ choisi. Deux groupes (Champs de base / Mes champs)
 *  pour rester COHÉRENT avec le sélecteur de la campagne (VarsEditor). */
function FieldPicker({ options, onPick, onClose }: {
  options: FieldOption[];
  onPick: (o: FieldOption) => void;
  onClose: () => void;
}) {
  const t = useT();
  const groups: Array<{ id: 'base' | 'custom'; label: string }> = [
    { id: 'base', label: t('Champs de base', 'Base fields') },
    { id: 'custom', label: t('Mes champs', 'My fields') },
  ];
  return (
    <>
      <button type="button" aria-label={t('Fermer', 'Close')} className="fixed inset-0 z-40 cursor-default" onClick={onClose} />
      <div className="absolute bottom-11 right-0 z-50 max-h-56 w-56 overflow-y-auto rounded-xl border border-ink-200 bg-white p-1 shadow-lg">
        {groups.map((g) => {
          const items = options.filter((o) => o.group === g.id);
          if (items.length === 0) return null;
          return (
            <div key={g.id}>
              <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-ink-400">{g.label}</div>
              {items.map((o, i) => (
                <button type="button" key={`${g.id}-${i}`} onClick={() => onPick(o)} className="block w-full truncate rounded-md px-2 py-1.5 text-left text-sm text-ink-700 hover:bg-brand-50">{o.label}</button>
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}

/** Ce que la canonicalisation rend : prêt à partir chez Meta, ou la liste des variables non rattachées. */
export interface CanonicalBody {
  /** Corps renuméroté en 1..N contigu (Meta EXIGE une suite sans trou). */
  body: string;
  /** Exemples alignés sur les positions canoniques. undefined si le corps n'a aucune variable. */
  example?: string[];
  /** Indices « position -> champ », persistés pour pré-remplir la campagne. */
  paramHints: TemplateParamHint[];
  /** Positions (canoniques) dont la variable n'est rattachée à AUCUN champ : à refuser avant l'envoi. */
  unmapped: number[];
}

export interface TemplateBodyState {
  body: string;
  setBody: (v: string) => void;
  examples: string[];
  setExamples: React.Dispatch<React.SetStateAction<string[]>>;
  varSources: Array<VarSource | undefined>;
  setVarSources: React.Dispatch<React.SetStateAction<Array<VarSource | undefined>>>;
  /** Champs du tenant (sélecteur de variable), chargés une fois. */
  userFields: UserFieldDef[];
  /** Positions de variables RÉELLEMENT présentes dans le corps (distinctes, triées). */
  positions: number[];
  /** Libellés par position, pour les chips de l'éditeur et de l'aperçu. */
  varLabels: Array<string | undefined>;
  /** Remet le corps à zéro après une création réussie. */
  reset: () => void;
  canonicalize: () => CanonicalBody;
  /** Interne au composant : l'éditeur riche (insertion au curseur). */
  editorRef: React.RefObject<VariableBodyEditorHandle | null>;
}

/**
 * État d'un corps de template avec variables. `tenantId` sert à charger les champs du sélecteur.
 * `initial` pré-remplit (édition d'un template existant).
 */
export function useTemplateBody(tenantId: string, initial?: { body?: string; example?: string[] }): TemplateBodyState {
  const [body, setBody] = useState(initial?.body ?? '');
  const [examples, setExamples] = useState<string[]>(initial?.example ?? []);
  const [varSources, setVarSources] = useState<Array<VarSource | undefined>>([]);
  const [userFields, setUserFields] = useState<UserFieldDef[]>([]);
  const editorRef = useRef<VariableBodyEditorHandle>(null);

  useEffect(() => {
    let alive = true;
    listUserFields(tenantId)
      .then((r) => { if (alive) setUserFields(r.fields); })
      .catch(() => { /* sélecteur réduit aux champs de base : le formulaire reste utilisable */ });
    return () => { alive = false; };
  }, [tenantId]);

  // Positions RÉELLES (et non un simple compte) : après suppression d'une variable du milieu, le corps n'est
  // plus 1..N contigu -> numérotation, exemples et indices se pilotent là-dessus, sinon collisions de {{n}}.
  const positions = useMemo(
    () => [...new Set([...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b),
    [body],
  );

  function canonicalize(): CanonicalBody {
    const order: number[] = [];
    const seen = new Set<number>();
    for (const mm of body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
      const p = Number(mm[1]);
      if (!seen.has(p)) { seen.add(p); order.push(p); }
    }
    const remap = new Map(order.map((old, i) => [old, i + 1]));
    const canonBody = body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_s, d) => `{{${remap.get(Number(d))}}}`);
    const canonSources = order.map((old) => varSources[old - 1]);
    const canonExamples = order.map((old) => examples[old - 1] ?? '');
    return {
      body: canonBody,
      ...(order.length > 0 ? { example: canonExamples.map((e) => e || 'exemple') } : {}),
      paramHints: canonSources
        .map((v, i): TemplateParamHint | null => (v ? { position: i + 1, source: v.source } : null))
        .filter((h): h is TemplateParamHint => h !== null),
      unmapped: canonSources.map((v, i) => (v ? null : i + 1)).filter((p): p is number => p !== null),
    };
  }

  return {
    body, setBody, examples, setExamples, varSources, setVarSources, userFields, positions,
    varLabels: varSources.map((v) => v?.label),
    reset: () => { setBody(''); setExamples([]); setVarSources([]); },
    canonicalize,
    editorRef,
  };
}

/**
 * Message d'erreur pour les variables non rattachées à un champ. Une variable tapée à la main partirait vide
 * à l'envoi et se ferait rejeter par Meta -> on refuse ici, avec la MÊME phrase partout.
 */
export function unmappedVariablesMessage(unmapped: number[], t: (fr: string, en?: string) => string): string {
  return `${t('Chaque variable doit être rattachée à un champ via « + Variable ». Non rattachée(s) :', 'Each variable must be linked to a field via “+ Variable”. Not linked:')} ${unmapped.map((p) => `{{${p}}}`).join(', ')}. ${t('Supprime-les puis réinsère-les avec le sélecteur.', 'Delete them then reinsert them with the picker.')}`;
}

/** Éditeur du corps : chips de variables, « + Variable » (rattache un champ + remplit l'exemple), emojis. */
export function TemplateBodyField({ state, label, placeholder, hint }: {
  state: TemplateBodyState;
  label: string;
  placeholder: string;
  /** Ligne d'aide sous l'éditeur. Absente -> la phrase standard sur « + Variable ». */
  hint?: string;
}) {
  const t = useT();
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [fieldPickerOpen, setFieldPickerOpen] = useState(false);

  // Source de vérité COMMUNE (web/lib/fields.ts) : les 6 champs de base + les champs perso (hors clés système).
  // Exactement la même liste que le sélecteur de la campagne (VarsEditor) -> cohérence de bout en bout.
  const fieldOptions: FieldOption[] = [
    { source: { type: 'now' } as ParamSource, label: t('Date du jour (auto)', "Today's date (auto)"), group: 'base' as const },
    ...SYSTEM_FIELDS.map((f) => ({ source: f.source, label: t(...f.label), group: 'base' as const })),
    ...customFieldsOnly(state.userFields).map((f) => ({ source: { type: 'field', key: f.key } as ParamSource, label: f.label, fieldType: f.type, group: 'custom' as const })),
  ];

  // Numéro = MAX des positions présentes + 1 (jamais le simple compte : après suppression d'un {{1}}, réutiliser
  // 2 créerait une collision {{2}}/{{2}}). La canonicalisation au submit compacte ensuite les trous.
  function insertVariable(opt: FieldOption) {
    const next = (state.positions.length ? Math.max(...state.positions) : 0) + 1;
    state.editorRef.current?.insertToken(`{{${next}}}`, opt.label);
    state.setVarSources((vs) => { const c = [...vs]; c[next - 1] = { source: opt.source, label: opt.label }; return c; });
    state.setExamples((ex) => { const c = [...ex]; c[next - 1] = deterministicExample(opt.source, opt.fieldType); return c; });
    setFieldPickerOpen(false);
  }

  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-ink-700">{label}</label>
      <div className="relative">
        <VariableBodyEditor
          ref={state.editorRef}
          value={state.body}
          varLabels={state.varLabels}
          onChange={state.setBody}
          placeholder={placeholder}
          className={`${inputCls} pr-28`}
        />
        <div className="absolute bottom-2 right-2 flex items-center gap-1">
          <button
            type="button"
            onClick={() => { setFieldPickerOpen((o) => !o); setEmojiOpen(false); }}
            className="rounded-md border border-ink-200 bg-white px-2 py-1 text-xs font-medium text-brand-600 hover:bg-brand-50"
            title={t('Insérer une variable (champ du contact)', 'Insert a variable (contact field)')}
          >
            + Variable
          </button>
          <button
            type="button"
            onClick={() => { setEmojiOpen((o) => !o); setFieldPickerOpen(false); }}
            className="rounded-md p-1 text-lg leading-none hover:bg-ink-100"
            aria-label={t('Insérer un emoji', 'Insert an emoji')}
          >
            😊
          </button>
        </div>
        {emojiOpen && <EmojiPicker onPick={(e) => state.editorRef.current?.insertToken(e)} onClose={() => setEmojiOpen(false)} />}
        {fieldPickerOpen && <FieldPicker options={fieldOptions} onPick={insertVariable} onClose={() => setFieldPickerOpen(false)} />}
      </div>
      <p className="mt-1 text-xs text-ink-400">
        {hint ?? t("Clique « + Variable » pour insérer un champ du contact (nom, prénom, email…) : l'exemple exigé par Meta se remplit tout seul.", 'Click “+ Variable” to insert a contact field (name, first name, email…): the example required by Meta fills in automatically.')}
      </p>
    </div>
  );
}

/** Les exemples exigés par Meta, une ligne par variable RÉELLEMENT présente dans le corps. */
export function TemplateVariableExamples({ state }: { state: TemplateBodyState }) {
  const t = useT();
  if (state.positions.length === 0) return null;
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-ink-700">{t('Exemples de variables (requis par Meta)', 'Variable examples (required by Meta)')}</label>
      <div className="space-y-2">
        {/* Piloté par les positions RÉELLES du corps (index pos-1), pas un compte séquentiel : après suppression
            d'une variable du milieu, chaque ligne reste alignée avec sa source/exemple. */}
        {state.positions.map((pos) => (
          <div key={pos} className="flex items-center gap-2">
            <span className="flex w-28 shrink-0 items-center gap-1 text-xs text-ink-400">
              {`{{${pos}}}`}
              {state.varSources[pos - 1] && <span className="truncate rounded bg-brand-50 px-1 text-brand-600">{state.varSources[pos - 1]!.label}</span>}
            </span>
            <input
              value={state.examples[pos - 1] ?? ''}
              onChange={(e) => state.setExamples((x) => { const c = [...x]; c[pos - 1] = e.target.value; return c; })}
              className={`${inputCls} flex-1`}
              placeholder={t('ex. Julie', 'e.g. Julie')}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
