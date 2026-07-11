'use client';

import { useEffect, useRef, useState } from 'react';
import {
  createFlow,
  publishFlow,
  listUserFields,
  type FlowFieldType,
  type FlowTextKind,
  type FlowElementInput,
  type UserFieldDef,
} from '@/lib/api';
import { resizeToDataUrl, dataUrlBase64Length } from '@/lib/image';

const TYPE_LABELS: Record<FlowFieldType, string> = {
  text: 'Texte', email: 'Email', phone: 'Téléphone', number: 'Nombre', textarea: 'Zone de texte', date: 'Date',
};
const TEXT_LABELS: Record<FlowTextKind, string> = {
  heading: 'Titre', subheading: 'Sous-titre', body: 'Paragraphe', caption: 'Légende',
};
// Même unité que le serveur (IMG_MAX = 400*1024 sur la LONGUEUR de la chaîne base64). Marge de 5% pour
// rejeter côté client avant le serveur (message clair au lieu d'un 400 au submit).
const IMG_MAX_B64 = Math.floor(400 * 1024 * 0.95);

type BElem =
  | { uid: number; kind: FlowTextKind; text: string }
  | { uid: number; kind: 'image'; src: string; uploading: boolean; error?: string }
  | { uid: number; kind: 'field'; label: string; type: FlowFieldType; required: boolean; saveTo: string };

const inputCls = 'rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

/**
 * Constructeur de Flow RICHE : une liste ordonnée d'éléments (titres/paragraphes/légendes, image, champ de
 * saisie). Chaque CHAMP se range dans un user field du contact au retour du formulaire : « Nouveau champ »
 * (créé d'après le libellé) par défaut, ou un user field existant choisi dans le select. `autoPublish` :
 * publie aussitôt (contexte template, où le flow doit être PUBLISHED pour être attaché à un bouton).
 */
export function FlowBuilder({
  tenantId,
  onCreated,
  autoPublish = false,
}: {
  tenantId: string;
  onCreated: (flow: { id: string; name: string; status: string }) => void;
  autoPublish?: boolean;
}) {
  const [name, setName] = useState('');
  const [elements, setElements] = useState<BElem[]>([{ uid: 1, kind: 'field', label: '', type: 'text', required: true, saveTo: '' }]);
  const [userFields, setUserFields] = useState<UserFieldDef[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const uidRef = useRef(2);
  const fileRefs = useRef<Record<number, HTMLInputElement | null>>({});

  useEffect(() => {
    listUserFields(tenantId).then(({ fields }) => setUserFields(fields)).catch(() => setUserFields([]));
  }, [tenantId]);

  const nextUid = () => uidRef.current++;
  function patch(uid: number, p: Partial<BElem>) {
    setElements((list) => list.map((e) => (e.uid === uid ? ({ ...e, ...p } as BElem) : e)));
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
  function addText(kind: FlowTextKind) {
    setElements((l) => [...l, { uid: nextUid(), kind, text: '' }]);
  }
  function addImage() {
    setElements((l) => [...l, { uid: nextUid(), kind: 'image', src: '', uploading: false }]);
  }
  function addField() {
    setElements((l) => [...l, { uid: nextUid(), kind: 'field', label: '', type: 'text', required: false, saveTo: '' }]);
  }

  async function onFile(uid: number, file: File | undefined) {
    if (!file) return;
    patch(uid, { uploading: true, error: undefined } as Partial<BElem>);
    try {
      const src = await resizeToDataUrl(file, 800, 0.8);
      if (dataUrlBase64Length(src) > IMG_MAX_B64) {
        patch(uid, { uploading: false, error: 'Image trop lourde même après compression. Choisis-en une plus petite.' } as Partial<BElem>);
        return;
      }
      patch(uid, { src, uploading: false } as Partial<BElem>);
    } catch (err) {
      patch(uid, { uploading: false, error: err instanceof Error ? err.message : 'Image illisible' } as Partial<BElem>);
    }
  }

  const fieldCount = elements.filter((e) => e.kind === 'field').length;
  const canSubmit =
    name.trim() !== '' &&
    fieldCount > 0 &&
    elements.every((e) =>
      e.kind === 'field' ? e.label.trim() !== '' : e.kind === 'image' ? e.src !== '' && !e.uploading : e.text.trim() !== '',
    ) &&
    !busy;

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      const payload: FlowElementInput[] = elements.map((e) => {
        if (e.kind === 'image') return { kind: 'image', src: e.src };
        if (e.kind === 'field') return { kind: 'field', label: e.label.trim(), type: e.type, required: e.required, ...(e.saveTo ? { saveTo: e.saveTo } : {}) };
        return { kind: e.kind, text: e.text.trim() };
      });
      const res = await createFlow(tenantId, { name: name.trim(), elements: payload });
      let status = res.status;
      if (autoPublish) {
        await publishFlow(tenantId, res.id);
        status = 'PUBLISHED';
      }
      setMsg({ kind: 'ok', text: autoPublish ? `Formulaire « ${res.name} » créé et publié.` : `Formulaire « ${res.name} » créé (brouillon). Publie-le pour l'utiliser.` });
      setName('');
      setElements([{ uid: nextUid(), kind: 'field', label: '', type: 'text', required: true, saveTo: '' }]);
      onCreated({ id: res.id, name: res.name, status });
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Création impossible' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1 block text-xs font-medium text-ink-600">Nom du formulaire</label>
        <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputCls} w-full max-w-sm`} placeholder="Demande de rendez-vous" />
      </div>

      <div className="space-y-2">
        {elements.map((e, i) => (
          <div key={e.uid} className="rounded-xl border border-ink-200 bg-white p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-ink-400">
                {e.kind === 'field' ? 'Champ' : e.kind === 'image' ? 'Image' : TEXT_LABELS[e.kind]}
              </span>
              <div className="flex items-center gap-1 text-ink-400">
                <button type="button" onClick={() => move(e.uid, -1)} disabled={i === 0} className="rounded px-1.5 py-0.5 hover:bg-ink-100 disabled:opacity-30" aria-label="Monter">↑</button>
                <button type="button" onClick={() => move(e.uid, 1)} disabled={i === elements.length - 1} className="rounded px-1.5 py-0.5 hover:bg-ink-100 disabled:opacity-30" aria-label="Descendre">↓</button>
                <button type="button" onClick={() => remove(e.uid)} className="rounded px-1.5 py-0.5 hover:bg-ink-100 hover:text-coral" aria-label="Retirer">✕</button>
              </div>
            </div>

            {(e.kind === 'heading' || e.kind === 'subheading' || e.kind === 'body' || e.kind === 'caption') && (
              <textarea value={e.text} onChange={(ev) => patch(e.uid, { text: ev.target.value } as Partial<BElem>)} rows={e.kind === 'body' ? 3 : 1} className={`${inputCls} w-full`} placeholder={`${TEXT_LABELS[e.kind]}…`} />
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
                    'Upload…'
                  ) : e.src ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={e.src} alt="Aperçu" className="h-full w-full object-cover" />
                  ) : (
                    'Choisir une image'
                  )}
                </button>
                <input
                  ref={(el) => { fileRefs.current[e.uid] = el; }}
                  type="file"
                  accept="image/png,image/jpeg"
                  className="hidden"
                  onChange={(ev) => onFile(e.uid, ev.target.files?.[0])}
                />
                {e.error && <p className="text-xs text-coral">{e.error}</p>}
              </div>
            )}

            {e.kind === 'field' && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <input value={e.label} onChange={(ev) => patch(e.uid, { label: ev.target.value } as Partial<BElem>)} className={`${inputCls} min-w-0 flex-1`} placeholder="Libellé du champ (ex. Email)" />
                  <select value={e.type} onChange={(ev) => patch(e.uid, { type: ev.target.value as FlowFieldType } as Partial<BElem>)} className={`${inputCls} bg-white`}>
                    {(Object.keys(TYPE_LABELS) as FlowFieldType[]).map((t) => (
                      <option key={t} value={t}>{TYPE_LABELS[t]}</option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1.5 text-xs text-ink-600">
                    <input type="checkbox" checked={e.required} onChange={(ev) => patch(e.uid, { required: ev.target.checked } as Partial<BElem>)} />
                    Obligatoire
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-ink-500">Enregistrer dans</span>
                  <select value={e.saveTo} onChange={(ev) => patch(e.uid, { saveTo: ev.target.value } as Partial<BElem>)} className={`${inputCls} bg-white`}>
                    <option value="">Nouveau champ (d&apos;après le libellé)</option>
                    {userFields.map((uf) => (
                      <option key={uf.key} value={uf.key}>{uf.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <span className="self-center text-ink-400">Ajouter :</span>
        <button type="button" onClick={() => addText('heading')} className="rounded-md border border-ink-200 px-2 py-1 text-brand-600 hover:bg-brand-50">Titre</button>
        <button type="button" onClick={() => addText('body')} className="rounded-md border border-ink-200 px-2 py-1 text-brand-600 hover:bg-brand-50">Paragraphe</button>
        <button type="button" onClick={() => addText('caption')} className="rounded-md border border-ink-200 px-2 py-1 text-brand-600 hover:bg-brand-50">Légende</button>
        <button type="button" onClick={addImage} className="rounded-md border border-ink-200 px-2 py-1 text-brand-600 hover:bg-brand-50">Image</button>
        <button type="button" onClick={addField} className="rounded-md border border-ink-200 px-2 py-1 font-medium text-brand-600 hover:bg-brand-50">+ Champ</button>
      </div>

      {fieldCount === 0 && <p className="text-xs text-gold">Ajoute au moins un champ : un formulaire sans champ ne collecte rien.</p>}

      {msg && <p className={`rounded-lg px-3 py-2 text-sm ${msg.kind === 'ok' ? 'bg-mint-50 text-mint-700' : 'bg-red-50 text-red-700'}`}>{msg.text}</p>}

      <button onClick={submit} disabled={!canSubmit} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-60">
        {busy ? 'Création…' : autoPublish ? 'Créer et publier' : 'Créer le formulaire'}
      </button>
    </div>
  );
}
