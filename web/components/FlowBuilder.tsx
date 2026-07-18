'use client';

import { useEffect, useRef, useState } from 'react';
import {
  createFlow,
  updateFlow,
  publishFlow,
  listUserFields,
  FLOW_CHOICE_TYPES,
  type FlowFieldType,
  type FlowTextKind,
  type FlowElement,
  type FlowElementInput,
  type FlowScreen as ApiFlowScreen,
  type FlowScreenInput,
  type FlowVisibleIfInput,
  type UserFieldDef,
} from '@/lib/api';
import { resizeToDataUrl, dataUrlBase64Length } from '@/lib/image';
import { isDefaultSaveTo } from '@/lib/flow-mapping';
import { FlowScreen, conditionText, type FlowScreenElement } from '@/components/FlowScreen';
import { useT } from '@/lib/i18n';

// Libellés bilingues [FR, EN] résolus au rendu via t(...) (useT est inappelable hors composant).
const TYPE_LABELS: Record<FlowFieldType, [string, string]> = {
  text: ['Texte', 'Text'], email: ['Email', 'Email'], phone: ['Téléphone', 'Phone'], number: ['Nombre', 'Number'], passcode: ['Code secret', 'Passcode'],
  textarea: ['Zone de texte', 'Text area'], date: ['Date', 'Date'],
  dropdown: ['Liste déroulante', 'Dropdown'], radio: ['Choix unique', 'Single choice'], checkbox: ['Choix multiple', 'Multiple choice'], optin: ['Consentement', 'Consent'],
};
const TEXT_LABELS: Record<FlowTextKind, [string, string]> = {
  heading: ['Titre', 'Heading'], subheading: ['Sous-titre', 'Subheading'], body: ['Paragraphe', 'Paragraph'], caption: ['Légende', 'Caption'],
};
const isChoice = (t: FlowFieldType): boolean => (FLOW_CHOICE_TYPES as FlowFieldType[]).includes(t);
const IMG_MAX_B64 = Math.floor(400 * 1024 * 0.95);

/** Types de champ admissibles comme SOURCE d'une condition « Visible si » (contrainte serveur). */
const COND_SOURCE_TYPES: FlowFieldType[] = ['dropdown', 'radio', 'optin'];
/** Apostrophe et accent grave interdits dans la valeur d'une condition (limite d'expression Meta). */
const hasForbiddenChar = (s: string): boolean => /['`]/.test(s);

type VisIf = { sourceUid: number; op: 'eq' | 'neq'; value: string | boolean };
type BElem =
  | { uid: number; kind: FlowTextKind; text: string; visibleIf?: VisIf }
  | { uid: number; kind: 'image'; src: string; uploading: boolean; error?: string; visibleIf?: VisIf }
  | { uid: number; kind: 'field'; label: string; type: FlowFieldType; required: boolean; saveTo: string; options: string[]; visibleIf?: VisIf };
type BField = Extract<BElem, { kind: 'field' }>;
type BScreen = { uid: number; title: string; cta: string; elements: BElem[] };

const inputCls = 'rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

const cleanOptions = (opts: string[]): string[] => [...new Set(opts.map((o) => o.trim()).filter((o) => o !== ''))];

function toDataUrl(src: string): string {
  return src.startsWith('data:') ? src : `data:image/jpeg;base64,${src}`;
}

/** Éléments d'édition (BElem) -> éléments d'écran WhatsApp (aperçu partagé), badge de condition compris. */
function bElemsToScreen(list: BElem[]): FlowScreenElement[] {
  return list.map((e): FlowScreenElement => {
    const src = e.visibleIf ? list.find((x) => x.uid === e.visibleIf!.sourceUid) : undefined;
    const cond = e.visibleIf && src && src.kind === 'field'
      ? { condition: conditionText(src.label.trim() || '?', e.visibleIf.op, e.visibleIf.value) }
      : {};
    if (e.kind === 'image') return { kind: 'image', src: e.src || null, ...cond };
    if (e.kind === 'field') return { kind: 'field', label: e.label, type: e.type, required: e.required, options: e.options, ...cond };
    return { kind: e.kind, text: e.text, ...cond };
  });
}

/** Éléments STOCKÉS d'UN écran -> éléments d'édition. Le visibleIf stocké porte `fieldKey` : on le résout vers
 *  l'uid d'un champ source ADMISSIBLE déjà rencontré dans le même écran (donc avant) ; introuvable -> droppé. */
function toBElems(elements: FlowElement[], mapping: Record<string, string>, startUid: number): { elems: BElem[]; nextUid: number } {
  let uid = startUid;
  const sourceUidByKey = new Map<string, number>();
  const elems = elements.map((e): BElem => {
    const u = uid++;
    const vis = e.visibleIf && sourceUidByKey.has(e.visibleIf.fieldKey)
      ? { visibleIf: { sourceUid: sourceUidByKey.get(e.visibleIf.fieldKey)!, op: e.visibleIf.op, value: e.visibleIf.value } }
      : {};
    if (e.kind === 'image') return { uid: u, kind: 'image', src: toDataUrl(e.src), uploading: false, ...vis };
    if (e.kind === 'field') {
      if (COND_SOURCE_TYPES.includes(e.type)) sourceUidByKey.set(e.key, u);
      const target = mapping[e.key];
      // « saveTo vide » = mapping PAR DÉFAUT (ne pas ré-sérialiser une cible explicite au round-trip d'édition).
      // La règle du défaut vit dans lib/flow-mapping.ts : fonction PURE, testée hors React.
      const saveTo = isDefaultSaveTo(e.type, target, e.key) ? '' : target ?? '';
      return { uid: u, kind: 'field', label: e.label, type: e.type, required: e.required, saveTo, options: e.options ?? [], ...vis };
    }
    return { uid: u, kind: e.kind, text: e.text, ...vis };
  });
  return { elems, nextUid: uid };
}

/** Écrans stockés -> écrans d'édition (seed du mode édition). */
function toBScreens(screens: ApiFlowScreen[], mapping: Record<string, string>, startUid: number): { screens: BScreen[]; nextUid: number } {
  let uid = startUid;
  const out = screens.map((s): BScreen => {
    const su = uid++;
    const r = toBElems(s.elements, mapping, uid);
    uid = r.nextUid;
    return { uid: su, title: s.title ?? '', cta: s.cta ?? '', elements: r.elems };
  });
  return { screens: out, nextUid: uid };
}

const emptySeed = (): { screens: BScreen[]; nextUid: number } => ({
  screens: [{ uid: 1, title: '', cta: '', elements: [{ uid: 2, kind: 'field', label: '', type: 'text', required: true, saveTo: '', options: [] }] }],
  nextUid: 3,
});

/** Invariants d'une condition : source existante, AVANT l'élément, de type dropdown/radio/optin, valeur du bon
 *  type (booléen pour optin, option encore existante pour dropdown/radio). Sinon : condition retirée ou valeur
 *  vidée. `changed` sert à prévenir l'utilisateur que sa condition a sauté. */
function sanitizeElems(list: BElem[]): { elems: BElem[]; changed: boolean } {
  let changed = false;
  const elems = list.map((e, i): BElem => {
    if (!e.visibleIf) return e;
    const si = list.findIndex((x) => x.uid === e.visibleIf!.sourceUid);
    const src = si >= 0 && si < i ? list[si] : undefined;
    if (!src || src.kind !== 'field' || !COND_SOURCE_TYPES.includes(src.type)) {
      changed = true;
      return { ...e, visibleIf: undefined } as BElem;
    }
    const v = e.visibleIf.value;
    if (src.type === 'optin' && typeof v !== 'boolean') {
      changed = true;
      return { ...e, visibleIf: { ...e.visibleIf, value: true } } as BElem;
    }
    if (src.type !== 'optin' && (typeof v !== 'string' || (v !== '' && !cleanOptions(src.options).includes(v)))) {
      changed = true;
      return { ...e, visibleIf: { ...e.visibleIf, value: '' } } as BElem;
    }
    return e;
  });
  return { elems: changed ? elems : list, changed };
}

/**
 * Constructeur visuel de WhatsApp Flow (formulaire) : 1 à 10 ÉCRANS (onglets), chacun avec sa liste ordonnée
 * d'éléments (textes, image, champs de tous types) et son titre d'en-tête ; les écrans intermédiaires ont un
 * bouton « Continuer » personnalisable, le dernier porte le bouton final global. Chaque élément peut être
 * conditionnel (« Visible si » un champ dropdown/radio/optin placé avant sur le même écran). Aperçu en direct
 * de l'écran actif. `mode='edit'` réécrit un DRAFT. `autoPublish` publie aussitôt (contexte template).
 */
export function FlowBuilder({
  tenantId,
  onCreated,
  autoPublish = false,
  mode = 'create',
  flowId,
  initialName,
  initialScreens,
  initialMapping,
  initialCta,
}: {
  tenantId: string;
  onCreated: (flow: { id: string; name: string; status: string }) => void;
  autoPublish?: boolean;
  mode?: 'create' | 'edit';
  flowId?: string;
  initialName?: string;
  initialScreens?: ApiFlowScreen[] | null;
  initialMapping?: Record<string, string> | null;
  initialCta?: string | null;
}) {
  const t = useT();
  const seedRef = useRef<{ screens: BScreen[]; nextUid: number } | null>(null);
  if (seedRef.current === null) {
    seedRef.current = initialScreens && initialScreens.length > 0
      ? toBScreens(initialScreens, initialMapping ?? {}, 1)
      : emptySeed();
  }
  const [name, setName] = useState(initialName ?? '');
  const [cta, setCta] = useState(initialCta ?? '');
  const [screens, setScreens] = useState<BScreen[]>(seedRef.current.screens);
  const [activeIdx, setActiveIdx] = useState(0);
  const [condOpen, setCondOpen] = useState<Set<number>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [userFields, setUserFields] = useState<UserFieldDef[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const uidRef = useRef(seedRef.current.nextUid);
  const fileRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const isEdit = mode === 'edit' && !!flowId;

  // Écran actif (index borné : filet si l'index n'a pas encore suivi une suppression).
  const idx = Math.min(activeIdx, screens.length - 1);
  const scr = screens[idx];

  useEffect(() => {
    listUserFields(tenantId).then(({ fields }) => setUserFields(fields)).catch(() => setUserFields([]));
  }, [tenantId]);

  const nextUid = () => uidRef.current++;

  /** Toute mutation d'éléments passe ici : applique fn puis resanitize les conditions de l'écran actif.
   *  État via updater fonctionnel + ciblage par uid d'écran (pas d'index) : pas de perte d'édits concurrents
   *  (ex. patch async post-upload) ni de mauvaise cible après réordonnancement. La notice est calculée sur le
   *  snapshot courant (best effort, fn est pure). */
  function mutateElems(fn: (elems: BElem[]) => BElem[]) {
    const screenUid = scr.uid;
    const probe = sanitizeElems(fn(scr.elements));
    setScreens((list) => list.map((s) => (s.uid === screenUid ? { ...s, elements: sanitizeElems(fn(s.elements)).elems } : s)));
    setNotice(probe.changed ? t('Une condition « Visible si » a été réinitialisée (champ source retiré, déplacé ou modifié).', 'A « Visible if » condition was reset (source field removed, moved or changed).') : null);
  }

  function patch(uid: number, p: Partial<BElem>) {
    mutateElems((list) => list.map((e) => (e.uid === uid ? ({ ...e, ...p } as BElem) : e)));
  }
  function patchField(uid: number, fn: (e: BField) => BField) {
    mutateElems((list) => list.map((e) => (e.uid === uid && e.kind === 'field' ? fn(e) : e)));
  }
  function remove(uid: number) {
    mutateElems((list) => list.filter((e) => e.uid !== uid));
  }
  function move(uid: number, dir: -1 | 1) {
    mutateElems((list) => {
      const i = list.findIndex((e) => e.uid === uid);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= list.length) return list;
      const copy = [...list];
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      return copy;
    });
  }
  function changeType(uid: number, type: FlowFieldType) {
    // Choix -> amorcer 2 options vides (Meta en exige >= 2). Vers un consentement (optin) -> on réinitialise
    // saveTo : une cible héritée d'un autre type ne serait pas un champ booléen (le serveur la refuserait) ;
    // vide = champ de consentement par défaut, l'utilisateur peut ensuite choisir un champ Oui/Non existant.
    patchField(uid, (e) => ({
      ...e,
      type,
      saveTo: type === 'optin' ? '' : e.saveTo,
      options: isChoice(type) && e.options.length < 2 ? ['', ''] : e.options,
    }));
  }
  function addText(kind: FlowTextKind) {
    mutateElems((l) => [...l, { uid: nextUid(), kind, text: '' }]);
  }
  function addImage() {
    mutateElems((l) => [...l, { uid: nextUid(), kind: 'image', src: '', uploading: false }]);
  }
  function addField() {
    mutateElems((l) => [...l, { uid: nextUid(), kind: 'field', label: '', type: 'text', required: false, saveTo: '', options: [] }]);
  }

  // --- Opérations d'écran (onglets) ---
  function addScreen() {
    if (screens.length >= 10) return;
    setScreens((list) => [...list, { uid: nextUid(), title: '', cta: '', elements: [] }]);
    setActiveIdx(screens.length); // le nouvel écran (index = ancienne longueur)
  }
  function removeScreen() {
    if (screens.length <= 1) return;
    if (scr.elements.length > 0 && !window.confirm(t("Supprimer l'écran actif et tous ses éléments ?", 'Delete the active screen and all its elements?'))) return;
    setScreens((list) => list.filter((_, i) => i !== idx));
    setActiveIdx(Math.min(idx, screens.length - 2));
  }
  function moveScreen(dir: -1 | 1) {
    const j = idx + dir;
    if (j < 0 || j >= screens.length) return;
    setScreens((list) => {
      const copy = [...list];
      [copy[idx], copy[j]] = [copy[j]!, copy[idx]!];
      return copy;
    });
    setActiveIdx(j);
  }
  function patchScreenMeta(p: Partial<Pick<BScreen, 'title' | 'cta'>>) {
    setScreens((list) => list.map((s, i) => (i === idx ? { ...s, ...p } : s)));
  }

  // --- Conditions de visibilité ---
  /** Sources admissibles pour un élément à l'index i : champs dropdown/radio/optin placés AVANT, même écran. */
  function sourcesBefore(list: BElem[], i: number): BField[] {
    return list.slice(0, i).filter((x): x is BField => x.kind === 'field' && COND_SOURCE_TYPES.includes(x.type));
  }
  function setVis(uid: number, vis: VisIf | null) {
    mutateElems((list) => list.map((e) => (e.uid === uid ? ({ ...e, visibleIf: vis ?? undefined } as BElem) : e)));
  }
  function toggleCond(uid: number) {
    setCondOpen((s) => {
      const n = new Set(s);
      if (n.has(uid)) n.delete(uid); else n.add(uid);
      return n;
    });
  }

  async function onFile(uid: number, file: File | undefined) {
    if (!file) return;
    patch(uid, { uploading: true, error: undefined } as Partial<BElem>);
    try {
      const src = await resizeToDataUrl(file, 800, 0.8);
      if (dataUrlBase64Length(src) > IMG_MAX_B64) {
        patch(uid, { uploading: false, error: t('Image trop lourde même après compression. Choisis-en une plus petite.', 'Image too heavy even after compression. Choose a smaller one.') } as Partial<BElem>);
        return;
      }
      patch(uid, { src, uploading: false } as Partial<BElem>);
    } catch (err) {
      patch(uid, { uploading: false, error: err instanceof Error ? err.message : t('Image illisible', 'Unreadable image') } as Partial<BElem>);
    }
  }

  // --- Validation (pré-valide les règles serveur pour l'UX ; le serveur reste l'arbitre) ---
  const allFields: BField[] = screens.flatMap((s) => s.elements.filter((e): e is BField => e.kind === 'field'));
  const fieldCount = allFields.length;
  // Approximation front de l'unicité serveur (comparaison en slug) : trim + lowercase, tous écrans confondus.
  const labelKeys = allFields.map((e) => e.label.trim().toLowerCase()).filter((l) => l !== '');
  const labelsUnique = new Set(labelKeys).size === labelKeys.length;
  const everyScreenFilled = screens.every((s) => s.elements.length >= 1);
  const elemOk = (e: BElem): boolean => {
    if (e.kind === 'field') {
      if (e.label.trim() === '') return false;
      if (isChoice(e.type)) return cleanOptions(e.options).length >= 2;
      return true;
    }
    if (e.kind === 'image') return e.src !== '' && !e.uploading;
    return e.text.trim() !== '';
  };
  const visOk = (list: BElem[], e: BElem, i: number): boolean => {
    if (!e.visibleIf) return true;
    const src = list.slice(0, i).find((x) => x.uid === e.visibleIf!.sourceUid);
    if (!src || src.kind !== 'field' || !COND_SOURCE_TYPES.includes(src.type)) return false;
    const v = e.visibleIf.value;
    if (src.type === 'optin') return typeof v === 'boolean';
    return typeof v === 'string' && v !== '' && !hasForbiddenChar(v) && cleanOptions(src.options).includes(v);
  };
  const canSubmit =
    name.trim() !== '' &&
    screens.length >= 1 && screens.length <= 10 &&
    everyScreenFilled &&
    fieldCount > 0 &&
    labelsUnique &&
    screens.every((s) => s.elements.every((e, i) => elemOk(e) && visOk(s.elements, e, i))) &&
    !busy;

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      const screensPayload: FlowScreenInput[] = screens.map((s, si) => {
        const isLast = si === screens.length - 1;
        const elements = s.elements.map((e): FlowElementInput => {
          // visibleIf sérialisé avec le LIBELLÉ du champ source : le serveur résout libellé -> clé.
          const src = e.visibleIf ? s.elements.find((x) => x.uid === e.visibleIf!.sourceUid) : undefined;
          const vis: { visibleIf?: FlowVisibleIfInput } = e.visibleIf && src && src.kind === 'field'
            ? { visibleIf: { field: src.label.trim(), op: e.visibleIf.op, value: e.visibleIf.value } }
            : {};
          if (e.kind === 'image') return { kind: 'image', src: e.src, ...vis };
          if (e.kind === 'field') {
            return {
              kind: 'field', label: e.label.trim(), type: e.type, required: e.required,
              // saveTo = champ cible choisi (facultatif). Pour un consentement (optin), le serveur valide que
              // la cible est un champ booléen ; sans cible, défaut serveur = whatsapp_optin.
              ...(e.saveTo ? { saveTo: e.saveTo } : {}),
              ...(isChoice(e.type) ? { options: cleanOptions(e.options) } : {}),
              ...vis,
            };
          }
          return { kind: e.kind, text: e.text.trim(), ...vis };
        });
        return {
          ...(s.title.trim() ? { title: s.title.trim() } : {}),
          // cta d'écran = bouton « Continuer » d'un écran INTERMÉDIAIRE ; le dernier porte le cta global du flow.
          ...(!isLast && s.cta.trim() ? { cta: s.cta.trim() } : {}),
          elements,
        };
      });
      const ctaTrim = cta.trim() || undefined;
      if (isEdit) {
        const res = await updateFlow(tenantId, flowId!, { name: name.trim(), screens: screensPayload, ...(ctaTrim ? { cta: ctaTrim } : {}) });
        setMsg({ kind: 'ok', text: t(`Formulaire « ${res.name} » mis à jour (brouillon).`, `Form "${res.name}" updated (draft).`) });
        onCreated({ id: res.id, name: res.name, status: res.status });
        return;
      }
      const res = await createFlow(tenantId, { name: name.trim(), screens: screensPayload, ...(ctaTrim ? { cta: ctaTrim } : {}) });
      let status = res.status;
      if (autoPublish) {
        await publishFlow(tenantId, res.id);
        status = 'PUBLISHED';
      }
      setMsg({ kind: 'ok', text: autoPublish ? t(`Formulaire « ${res.name} » créé et publié.`, `Form "${res.name}" created and published.`) : t(`Formulaire « ${res.name} » créé (brouillon). Publie-le pour l'utiliser.`, `Form "${res.name}" created (draft). Publish it to use it.`) });
      setName('');
      setCta('');
      setScreens([{ uid: nextUid(), title: '', cta: '', elements: [{ uid: nextUid(), kind: 'field', label: '', type: 'text', required: true, saveTo: '', options: [] }] }]);
      setActiveIdx(0);
      setCondOpen(new Set());
      setNotice(null);
      onCreated({ id: res.id, name: res.name, status });
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : t('Enregistrement impossible', 'Could not save') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
      {/* Colonne éditeur */}
      <div className="space-y-4">
        <div className="flex flex-wrap gap-3">
          <div className="min-w-[200px] flex-1">
            <label className="mb-1 block text-xs font-medium text-ink-600">{t('Nom du formulaire', 'Form name')}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputCls} w-full`} placeholder={t('Demande de rendez-vous', 'Appointment request')} />
          </div>
          <div className="min-w-[160px]">
            <label className="mb-1 block text-xs font-medium text-ink-600">{t('Bouton final (dernier écran)', 'Final button (last screen)')}</label>
            <input value={cta} onChange={(e) => setCta(e.target.value)} maxLength={30} className={`${inputCls} w-full`} placeholder={t('Envoyer', 'Send')} />
          </div>
        </div>

        {/* Onglets d'écrans : le formulaire peut avoir 1 à 10 écrans, l'éditeur agit sur l'écran actif. */}
        <div className="space-y-3 rounded-xl border border-ink-200 bg-ink-50/60 p-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {screens.map((s, i) => (
              <button
                key={s.uid}
                type="button"
                onClick={() => setActiveIdx(i)}
                className={`max-w-[140px] truncate rounded-lg px-2.5 py-1 text-xs ${i === idx ? 'bg-brand-500 font-medium text-white' : 'border border-ink-200 bg-white text-ink-600 hover:bg-brand-50'}`}
              >
                {s.title.trim() || `${t('Écran', 'Screen')} ${i + 1}`}
              </button>
            ))}
            <button type="button" onClick={addScreen} disabled={screens.length >= 10} className="rounded-lg border border-dashed border-ink-300 px-2.5 py-1 text-xs font-medium text-brand-600 hover:bg-brand-50 disabled:opacity-30" title={t('10 écrans maximum', '10 screens maximum')}>{t('+ écran', '+ screen')}</button>
            <span className="mx-0.5 h-4 w-px bg-ink-200" />
            <button type="button" onClick={() => moveScreen(-1)} disabled={idx === 0} className="rounded px-1.5 py-0.5 text-xs text-ink-400 hover:bg-ink-100 disabled:opacity-30" aria-label={t("Déplacer l'écran vers la gauche", 'Move screen left')}>◀</button>
            <button type="button" onClick={() => moveScreen(1)} disabled={idx === screens.length - 1} className="rounded px-1.5 py-0.5 text-xs text-ink-400 hover:bg-ink-100 disabled:opacity-30" aria-label={t("Déplacer l'écran vers la droite", 'Move screen right')}>▶</button>
            <button type="button" onClick={removeScreen} disabled={screens.length <= 1} className="rounded px-1.5 py-0.5 text-xs text-ink-400 hover:bg-ink-100 hover:text-coral disabled:opacity-30" aria-label={t("Supprimer l'écran actif", 'Delete active screen')}>✕</button>
          </div>
          <div className="flex flex-wrap gap-3">
            <div className="min-w-[200px] flex-1">
              <label className="mb-1 block text-xs font-medium text-ink-600">{t("Titre de l'écran (en-tête WhatsApp)", 'Screen title (WhatsApp header)')}</label>
              <input value={scr.title} onChange={(e) => patchScreenMeta({ title: e.target.value })} maxLength={30} className={`${inputCls} w-full`} placeholder={t('Vos coordonnées', 'Your details')} />
            </div>
            {idx < screens.length - 1 && (
              <div className="min-w-[160px]">
                <label className="mb-1 block text-xs font-medium text-ink-600">{t('Bouton Continuer', 'Continue button')}</label>
                <input value={scr.cta} onChange={(e) => patchScreenMeta({ cta: e.target.value })} maxLength={30} className={`${inputCls} w-full`} placeholder={t('Continuer', 'Continue')} />
              </div>
            )}
          </div>
        </div>

        <div className="space-y-2">
          {scr.elements.map((e, i) => (
            <div key={e.uid} className="rounded-xl border border-ink-200 bg-white p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wide text-ink-400">
                  {e.kind === 'field' ? t('Champ', 'Field') : e.kind === 'image' ? t('Image', 'Image') : t(...TEXT_LABELS[e.kind])}
                </span>
                <div className="flex items-center gap-1 text-ink-400">
                  <button type="button" onClick={() => move(e.uid, -1)} disabled={i === 0} className="rounded px-1.5 py-0.5 hover:bg-ink-100 disabled:opacity-30" aria-label={t('Monter', 'Move up')}>↑</button>
                  <button type="button" onClick={() => move(e.uid, 1)} disabled={i === scr.elements.length - 1} className="rounded px-1.5 py-0.5 hover:bg-ink-100 disabled:opacity-30" aria-label={t('Descendre', 'Move down')}>↓</button>
                  <button type="button" onClick={() => remove(e.uid)} className="rounded px-1.5 py-0.5 hover:bg-ink-100 hover:text-coral" aria-label={t('Retirer', 'Remove')}>✕</button>
                </div>
              </div>

              {(e.kind === 'heading' || e.kind === 'subheading' || e.kind === 'body' || e.kind === 'caption') && (
                <textarea value={e.text} onChange={(ev) => patch(e.uid, { text: ev.target.value } as Partial<BElem>)} rows={e.kind === 'body' ? 3 : 1} className={`${inputCls} w-full`} placeholder={`${t(...TEXT_LABELS[e.kind])}…`} />
              )}

              {e.kind === 'image' && (
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={() => fileRefs.current[e.uid]?.click()}
                    disabled={e.uploading}
                    className="flex aspect-video w-full max-w-xs items-center justify-center overflow-hidden rounded-lg border border-dashed border-ink-300 bg-ink-50 text-xs text-ink-400 hover:border-brand-400 disabled:cursor-not-allowed"
                  >
                    {e.uploading ? (
                      t('Upload…', 'Uploading…')
                    ) : e.src ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={e.src} alt={t('Aperçu', 'Preview')} className="h-full w-full object-cover" />
                    ) : (
                      t('Choisir une image', 'Choose an image')
                    )}
                  </button>
                  <input ref={(el) => { fileRefs.current[e.uid] = el; }} type="file" accept="image/png,image/jpeg" className="hidden" onChange={(ev) => onFile(e.uid, ev.target.files?.[0])} />
                  {e.error && <p className="text-xs text-coral">{e.error}</p>}
                </div>
              )}

              {e.kind === 'field' && (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <input value={e.label} onChange={(ev) => patch(e.uid, { label: ev.target.value } as Partial<BElem>)} className={`${inputCls} min-w-0 flex-1`} placeholder={t('Libellé du champ (ex. Email)', 'Field label (e.g. Email)')} />
                    <select value={e.type} onChange={(ev) => changeType(e.uid, ev.target.value as FlowFieldType)} className={`${inputCls} bg-white`}>
                      {(Object.keys(TYPE_LABELS) as FlowFieldType[]).map((ft) => (
                        <option key={ft} value={ft}>{t(...TYPE_LABELS[ft])}</option>
                      ))}
                    </select>
                    <label className="flex items-center gap-1.5 text-xs text-ink-600">
                      <input type="checkbox" checked={e.required} onChange={(ev) => patch(e.uid, { required: ev.target.checked } as Partial<BElem>)} />
                      {t('Obligatoire', 'Required')}
                    </label>
                  </div>

                  {isChoice(e.type) && (
                    <div className="space-y-1.5 rounded-lg bg-ink-50 p-2">
                      <span className="text-xs text-ink-500">{t('Options (au moins 2)', 'Options (at least 2)')}</span>
                      {e.options.map((opt, oi) => (
                        <div key={oi} className="flex items-center gap-2">
                          <input
                            value={opt}
                            onChange={(ev) => patchField(e.uid, (f) => ({ ...f, options: f.options.map((o, k) => (k === oi ? ev.target.value : o)) }))}
                            className={`${inputCls} min-w-0 flex-1 py-1`}
                            placeholder={`${t('Option', 'Option')} ${oi + 1}`}
                          />
                          <button type="button" onClick={() => patchField(e.uid, (f) => ({ ...f, options: f.options.filter((_, k) => k !== oi) }))} className="text-ink-400 hover:text-coral" aria-label={t("Retirer l'option", 'Remove option')}>✕</button>
                        </div>
                      ))}
                      <button type="button" onClick={() => patchField(e.uid, (f) => ({ ...f, options: [...f.options, ''] }))} className="text-xs font-medium text-brand-600 hover:text-brand-700">{t('+ option', '+ option')}</button>
                    </div>
                  )}

                  <div className="flex items-center gap-2">
                    <span className="text-xs text-ink-500">{t('Enregistrer dans', 'Save to')}</span>
                    {e.type === 'optin' ? (
                      // Consentement : cible = champ Oui/Non uniquement (le serveur refuse un champ non booléen).
                      // Sans cible = champ de consentement par défaut (whatsapp_optin), qui ouvre le statut opt-in.
                      <select value={e.saveTo} onChange={(ev) => patch(e.uid, { saveTo: ev.target.value } as Partial<BElem>)} className={`${inputCls} bg-white`}>
                        <option value="">{t('Consentement WhatsApp (par défaut)', 'WhatsApp consent (default)')}</option>
                        {userFields.filter((uf) => uf.type === 'boolean').map((uf) => (
                          <option key={uf.key} value={uf.key}>{uf.label}</option>
                        ))}
                      </select>
                    ) : (
                      <select value={e.saveTo} onChange={(ev) => patch(e.uid, { saveTo: ev.target.value } as Partial<BElem>)} className={`${inputCls} bg-white`}>
                        <option value="">{t("Nouveau champ (d'après le libellé)", 'New field (from label)')}</option>
                        {userFields.map((uf) => (
                          <option key={uf.key} value={uf.key}>{uf.label}</option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>
              )}

              {/* Condition de visibilité (repliable, discrète). Sources : champs dropdown/radio/optin placés AVANT. */}
              {(() => {
                const sources = sourcesBefore(scr.elements, i);
                if (sources.length === 0 && !e.visibleIf) return null;
                const open = condOpen.has(e.uid);
                const curSrc = e.visibleIf ? sources.find((s) => s.uid === e.visibleIf!.sourceUid) : undefined;
                const forbiddenOpts = curSrc && curSrc.type !== 'optin' && cleanOptions(curSrc.options).some(hasForbiddenChar);
                return (
                  <div className="mt-2 border-t border-ink-100 pt-2">
                    <button type="button" onClick={() => toggleCond(e.uid)} className="text-[11px] text-ink-400 hover:text-ink-600">
                      👁 {e.visibleIf && curSrc
                        ? `${t('Visible si', 'Visible if')} ${conditionText(curSrc.label.trim() || '?', e.visibleIf.op, e.visibleIf.value)}`
                        : t('Visible si… (toujours visible)', 'Visible if… (always visible)')} {open ? '▴' : '▾'}
                    </button>
                    {open && (
                      <div className="mt-1.5 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <select
                            value={curSrc ? String(curSrc.uid) : ''}
                            onChange={(ev) => {
                              if (ev.target.value === '') { setVis(e.uid, null); return; }
                              const srcUid = Number(ev.target.value);
                              const src = sources.find((s) => s.uid === srcUid);
                              if (!src) return;
                              // Valeur amorcée selon le type du source : optin -> coché, choix -> à choisir.
                              setVis(e.uid, { sourceUid: srcUid, op: 'eq', value: src.type === 'optin' ? true : '' });
                            }}
                            className={`${inputCls} bg-white py-1 text-xs`}
                          >
                            <option value="">{t('(toujours visible)', '(always visible)')}</option>
                            {sources.map((s) => (
                              <option key={s.uid} value={String(s.uid)}>{s.label.trim() || t('Champ sans libellé', 'Unlabeled field')}</option>
                            ))}
                          </select>
                          {e.visibleIf && curSrc && (
                            <>
                              <select
                                value={e.visibleIf.op}
                                onChange={(ev) => setVis(e.uid, { ...e.visibleIf!, op: ev.target.value as 'eq' | 'neq' })}
                                className={`${inputCls} bg-white py-1 text-xs`}
                              >
                                <option value="eq">{t('est', 'is')}</option>
                                <option value="neq">{t("n'est pas", 'is not')}</option>
                              </select>
                              {curSrc.type === 'optin' ? (
                                <select
                                  value={e.visibleIf.value === false ? 'false' : 'true'}
                                  onChange={(ev) => setVis(e.uid, { ...e.visibleIf!, value: ev.target.value === 'true' })}
                                  className={`${inputCls} bg-white py-1 text-xs`}
                                >
                                  <option value="true">{t('coché', 'checked')}</option>
                                  <option value="false">{t('non coché', 'unchecked')}</option>
                                </select>
                              ) : (
                                <select
                                  value={typeof e.visibleIf.value === 'string' ? e.visibleIf.value : ''}
                                  onChange={(ev) => setVis(e.uid, { ...e.visibleIf!, value: ev.target.value })}
                                  className={`${inputCls} bg-white py-1 text-xs`}
                                >
                                  <option value="">{t('Choisir…', 'Choose…')}</option>
                                  {cleanOptions(curSrc.options).map((o) => (
                                    <option key={o} value={o} disabled={hasForbiddenChar(o)}>{o}</option>
                                  ))}
                                </select>
                              )}
                            </>
                          )}
                        </div>
                        {forbiddenOpts && (
                          <p className="text-[10px] text-ink-400">{t('Les options contenant une apostrophe ou un accent grave sont grisées : Meta les refuse dans une condition.', 'Options containing an apostrophe or a backtick are greyed out: Meta rejects them in a condition.')}</p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-2 text-xs">
          <span className="self-center text-ink-400">{t('Ajouter :', 'Add:')}</span>
          <button type="button" onClick={() => addText('heading')} className="rounded-md border border-ink-200 px-2 py-1 text-brand-600 hover:bg-brand-50">{t('Titre', 'Heading')}</button>
          <button type="button" onClick={() => addText('subheading')} className="rounded-md border border-ink-200 px-2 py-1 text-brand-600 hover:bg-brand-50">{t('Sous-titre', 'Subheading')}</button>
          <button type="button" onClick={() => addText('body')} className="rounded-md border border-ink-200 px-2 py-1 text-brand-600 hover:bg-brand-50">{t('Paragraphe', 'Paragraph')}</button>
          <button type="button" onClick={() => addText('caption')} className="rounded-md border border-ink-200 px-2 py-1 text-brand-600 hover:bg-brand-50">{t('Légende', 'Caption')}</button>
          <button type="button" onClick={addImage} className="rounded-md border border-ink-200 px-2 py-1 text-brand-600 hover:bg-brand-50">{t('Image', 'Image')}</button>
          <button type="button" onClick={addField} className="rounded-md border border-ink-200 px-2 py-1 font-medium text-brand-600 hover:bg-brand-50">{t('+ Champ', '+ Field')}</button>
        </div>

        {notice && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">{notice}</p>}
        {scr.elements.length === 0 && <p className="text-xs text-gold">{t('Cet écran est vide : ajoute au moins un élément (le serveur le refuserait).', 'This screen is empty: add at least one element (the server would refuse it).')}</p>}
        {fieldCount === 0 && <p className="text-xs text-gold">{t('Ajoute au moins un champ : un formulaire sans champ ne collecte rien.', 'Add at least one field: a form with no field collects nothing.')}</p>}
        {!labelsUnique && <p className="text-xs text-gold">{t('Deux champs portent le même libellé : chaque libellé doit être unique, tous écrans confondus.', 'Two fields share the same label: each label must be unique across all screens.')}</p>}
        {msg && <p className={`rounded-lg px-3 py-2 text-sm ${msg.kind === 'ok' ? 'bg-mint-50 text-mint-700' : 'bg-red-50 text-red-700'}`}>{msg.text}</p>}

        <button onClick={submit} disabled={!canSubmit} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-60">
          {busy ? t('Enregistrement…', 'Saving…') : isEdit ? t('Enregistrer les modifications', 'Save changes') : autoPublish ? t('Créer et publier', 'Create and publish') : t('Créer le formulaire', 'Create form')}
        </button>
      </div>

      {/* Colonne aperçu (collante) : écran actif + pagination quand il y a plusieurs écrans. */}
      <div className="lg:sticky lg:top-4 lg:h-fit">
        <p className="mb-2 text-xs font-medium text-ink-500">{t('Aperçu du formulaire (vue client WhatsApp)', 'Form preview (WhatsApp client view)')}</p>
        {screens.length > 1 && (
          <div className="mb-2 flex items-center justify-center gap-2 text-xs text-ink-500">
            <button type="button" onClick={() => setActiveIdx(Math.max(0, idx - 1))} disabled={idx === 0} className="rounded px-1.5 py-0.5 hover:bg-ink-100 disabled:opacity-30" aria-label={t('Écran précédent', 'Previous screen')}>◀</button>
            <span>{t('Écran', 'Screen')} {idx + 1}/{screens.length}</span>
            <button type="button" onClick={() => setActiveIdx(Math.min(screens.length - 1, idx + 1))} disabled={idx === screens.length - 1} className="rounded px-1.5 py-0.5 hover:bg-ink-100 disabled:opacity-30" aria-label={t('Écran suivant', 'Next screen')}>▶</button>
          </div>
        )}
        <FlowScreen
          elements={bElemsToScreen(scr.elements)}
          // Footer contextuel : écran intermédiaire -> son « Continuer », dernier -> le bouton final global.
          cta={idx === screens.length - 1 ? cta : (scr.cta.trim() || t('Continuer', 'Continue'))}
          title={scr.title.trim() || name}
        />
      </div>
    </div>
  );
}
