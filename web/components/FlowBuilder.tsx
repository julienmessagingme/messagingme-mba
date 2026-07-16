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
  type UserFieldDef,
} from '@/lib/api';
import { resizeToDataUrl, dataUrlBase64Length } from '@/lib/image';
import { FlowScreen, type FlowScreenElement } from '@/components/FlowScreen';
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

type BElem =
  | { uid: number; kind: FlowTextKind; text: string }
  | { uid: number; kind: 'image'; src: string; uploading: boolean; error?: string }
  | { uid: number; kind: 'field'; label: string; type: FlowFieldType; required: boolean; saveTo: string; options: string[] };

const inputCls = 'rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

function toDataUrl(src: string): string {
  return src.startsWith('data:') ? src : `data:image/jpeg;base64,${src}`;
}

/** Éléments d'édition (BElem) -> éléments d'écran WhatsApp (rendu d'aperçu partagé). */
function bElemsToScreen(list: BElem[]): FlowScreenElement[] {
  return list.map((e): FlowScreenElement => {
    if (e.kind === 'image') return { kind: 'image', src: e.src || null };
    if (e.kind === 'field') return { kind: 'field', label: e.label, type: e.type, required: e.required, options: e.options };
    return { kind: e.kind, text: e.text };
  });
}

function toBElems(elements: FlowElement[], mapping: Record<string, string>, startUid: number): { elems: BElem[]; nextUid: number } {
  let uid = startUid;
  const elems = elements.map((e): BElem => {
    if (e.kind === 'image') return { uid: uid++, kind: 'image', src: toDataUrl(e.src), uploading: false };
    if (e.kind === 'field') {
      const target = mapping[e.key];
      return { uid: uid++, kind: 'field', label: e.label, type: e.type, required: e.required, saveTo: target && target !== e.key ? target : '', options: e.options ?? [] };
    }
    return { uid: uid++, kind: e.kind, text: e.text };
  });
  return { elems, nextUid: uid };
}

const emptySeed = (): { elems: BElem[]; nextUid: number } => ({
  elems: [{ uid: 1, kind: 'field', label: '', type: 'text', required: true, saveTo: '', options: [] }],
  nextUid: 2,
});

/**
 * Constructeur visuel de WhatsApp Flow (formulaire) : liste ordonnée d'éléments (textes, image, champs de
 * saisie de TOUS types : texte/email/téléphone/nombre/code, zone de texte, date, listes/choix à options,
 * consentement). Libellé du bouton final personnalisable. Aperçu en direct de l'écran WhatsApp. Chaque champ
 * se range dans un user field. `mode='edit'` réécrit un DRAFT. `autoPublish` publie aussitôt (contexte template).
 */
export function FlowBuilder({
  tenantId,
  onCreated,
  autoPublish = false,
  mode = 'create',
  flowId,
  initialName,
  initialElements,
  initialMapping,
  initialCta,
}: {
  tenantId: string;
  onCreated: (flow: { id: string; name: string; status: string }) => void;
  autoPublish?: boolean;
  mode?: 'create' | 'edit';
  flowId?: string;
  initialName?: string;
  initialElements?: FlowElement[] | null;
  initialMapping?: Record<string, string> | null;
  initialCta?: string | null;
}) {
  const t = useT();
  const seedRef = useRef<{ elems: BElem[]; nextUid: number } | null>(null);
  if (seedRef.current === null) {
    seedRef.current = initialElements && initialElements.length > 0
      ? toBElems(initialElements, initialMapping ?? {}, 1)
      : emptySeed();
  }
  const [name, setName] = useState(initialName ?? '');
  const [cta, setCta] = useState(initialCta ?? '');
  const [elements, setElements] = useState<BElem[]>(seedRef.current.elems);
  const [userFields, setUserFields] = useState<UserFieldDef[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const uidRef = useRef(seedRef.current.nextUid);
  const fileRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const isEdit = mode === 'edit' && !!flowId;

  useEffect(() => {
    listUserFields(tenantId).then(({ fields }) => setUserFields(fields)).catch(() => setUserFields([]));
  }, [tenantId]);

  const nextUid = () => uidRef.current++;
  function patch(uid: number, p: Partial<BElem>) {
    setElements((list) => list.map((e) => (e.uid === uid ? ({ ...e, ...p } as BElem) : e)));
  }
  function patchField(uid: number, fn: (e: Extract<BElem, { kind: 'field' }>) => Extract<BElem, { kind: 'field' }>) {
    setElements((list) => list.map((e) => (e.uid === uid && e.kind === 'field' ? fn(e) : e)));
  }
  function remove(uid: number) {
    setElements((list) => list.filter((e) => e.uid !== uid));
  }
  function move(uid: number, dir: -1 | 1) {
    setElements((list) => {
      const i = list.findIndex((e) => e.uid === uid);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= list.length) return list;
      const copy = [...list];
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      return copy;
    });
  }
  function changeType(uid: number, type: FlowFieldType) {
    // Choix -> amorcer 2 options vides (Meta en exige >= 2). Consentement (optin) -> il se range TOUJOURS
    // dans un champ booléen dédié : on réinitialise saveTo (sinon un saveTo orphelin d'un ancien type
    // écrirait le booléen de consentement dans un autre champ).
    patchField(uid, (e) => ({
      ...e,
      type,
      saveTo: type === 'optin' ? '' : e.saveTo,
      options: isChoice(type) && e.options.length < 2 ? ['', ''] : e.options,
    }));
  }
  function addText(kind: FlowTextKind) {
    setElements((l) => [...l, { uid: nextUid(), kind, text: '' }]);
  }
  function addImage() {
    setElements((l) => [...l, { uid: nextUid(), kind: 'image', src: '', uploading: false }]);
  }
  function addField() {
    setElements((l) => [...l, { uid: nextUid(), kind: 'field', label: '', type: 'text', required: false, saveTo: '', options: [] }]);
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

  const fieldCount = elements.filter((e) => e.kind === 'field').length;
  const cleanOptions = (opts: string[]): string[] => [...new Set(opts.map((o) => o.trim()).filter((o) => o !== ''))];
  const canSubmit =
    name.trim() !== '' &&
    fieldCount > 0 &&
    elements.every((e) => {
      if (e.kind === 'field') {
        if (e.label.trim() === '') return false;
        if (isChoice(e.type)) return cleanOptions(e.options).length >= 2;
        return true;
      }
      if (e.kind === 'image') return e.src !== '' && !e.uploading;
      return e.text.trim() !== '';
    }) &&
    !busy;

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      const payload: FlowElementInput[] = elements.map((e) => {
        if (e.kind === 'image') return { kind: 'image', src: e.src };
        if (e.kind === 'field') {
          return {
            kind: 'field', label: e.label.trim(), type: e.type, required: e.required,
            // Jamais de saveTo sur un consentement : il va toujours dans un champ booléen dédié.
            ...(e.saveTo && e.type !== 'optin' ? { saveTo: e.saveTo } : {}),
            ...(isChoice(e.type) ? { options: cleanOptions(e.options) } : {}),
          };
        }
        return { kind: e.kind, text: e.text.trim() };
      });
      const ctaTrim = cta.trim() || undefined;
      if (isEdit) {
        const res = await updateFlow(tenantId, flowId!, { name: name.trim(), elements: payload, ...(ctaTrim ? { cta: ctaTrim } : {}) });
        setMsg({ kind: 'ok', text: t(`Formulaire « ${res.name} » mis à jour (brouillon).`, `Form "${res.name}" updated (draft).`) });
        onCreated({ id: res.id, name: res.name, status: res.status });
        return;
      }
      const res = await createFlow(tenantId, { name: name.trim(), elements: payload, ...(ctaTrim ? { cta: ctaTrim } : {}) });
      let status = res.status;
      if (autoPublish) {
        await publishFlow(tenantId, res.id);
        status = 'PUBLISHED';
      }
      setMsg({ kind: 'ok', text: autoPublish ? t(`Formulaire « ${res.name} » créé et publié.`, `Form "${res.name}" created and published.`) : t(`Formulaire « ${res.name} » créé (brouillon). Publie-le pour l'utiliser.`, `Form "${res.name}" created (draft). Publish it to use it.`) });
      setName('');
      setCta('');
      setElements([{ uid: nextUid(), kind: 'field', label: '', type: 'text', required: true, saveTo: '', options: [] }]);
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
            <label className="mb-1 block text-xs font-medium text-ink-600">{t('Bouton final', 'Final button')}</label>
            <input value={cta} onChange={(e) => setCta(e.target.value)} maxLength={30} className={`${inputCls} w-full`} placeholder={t('Envoyer', 'Send')} />
          </div>
        </div>

        <div className="space-y-2">
          {elements.map((e, i) => (
            <div key={e.uid} className="rounded-xl border border-ink-200 bg-white p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wide text-ink-400">
                  {e.kind === 'field' ? t('Champ', 'Field') : e.kind === 'image' ? t('Image', 'Image') : t(...TEXT_LABELS[e.kind])}
                </span>
                <div className="flex items-center gap-1 text-ink-400">
                  <button type="button" onClick={() => move(e.uid, -1)} disabled={i === 0} className="rounded px-1.5 py-0.5 hover:bg-ink-100 disabled:opacity-30" aria-label={t('Monter', 'Move up')}>↑</button>
                  <button type="button" onClick={() => move(e.uid, 1)} disabled={i === elements.length - 1} className="rounded px-1.5 py-0.5 hover:bg-ink-100 disabled:opacity-30" aria-label={t('Descendre', 'Move down')}>↓</button>
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

                  {e.type !== 'optin' && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-ink-500">{t('Enregistrer dans', 'Save to')}</span>
                      <select value={e.saveTo} onChange={(ev) => patch(e.uid, { saveTo: ev.target.value } as Partial<BElem>)} className={`${inputCls} bg-white`}>
                        <option value="">{t("Nouveau champ (d'après le libellé)", 'New field (from label)')}</option>
                        {userFields.map((uf) => (
                          <option key={uf.key} value={uf.key}>{uf.label}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              )}
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

        {fieldCount === 0 && <p className="text-xs text-gold">{t('Ajoute au moins un champ : un formulaire sans champ ne collecte rien.', 'Add at least one field: a form with no field collects nothing.')}</p>}
        {msg && <p className={`rounded-lg px-3 py-2 text-sm ${msg.kind === 'ok' ? 'bg-mint-50 text-mint-700' : 'bg-red-50 text-red-700'}`}>{msg.text}</p>}

        <button onClick={submit} disabled={!canSubmit} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-60">
          {busy ? t('Enregistrement…', 'Saving…') : isEdit ? t('Enregistrer les modifications', 'Save changes') : autoPublish ? t('Créer et publier', 'Create and publish') : t('Créer le formulaire', 'Create form')}
        </button>
      </div>

      {/* Colonne aperçu (collante) */}
      <div className="lg:sticky lg:top-4 lg:h-fit">
        <p className="mb-2 text-xs font-medium text-ink-500">{t('Aperçu du formulaire (vue client WhatsApp)', 'Form preview (WhatsApp client view)')}</p>
        <FlowScreen elements={bElemsToScreen(elements)} cta={cta} title={name} />
      </div>
    </div>
  );
}

