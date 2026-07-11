'use client';

import { useRef, useState } from 'react';
import { createTemplate, uploadMedia, type TemplateButtonInput } from '@/lib/api';
import { resizeToDataUrl } from '@/lib/image';

interface Card {
  headerHandle: string;
  preview: string;
  body: string;
  uploading: boolean;
  error?: string;
}

const emptyCard = (): Card => ({ headerHandle: '', preview: '', body: '', uploading: false });
const inputCls = 'rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

/** Aperçu façon WhatsApp d'un carousel : bulle d'intro + cartes défilables (image + texte + boutons). */
function CarouselPreview({ body, cards, buttons }: { body: string; cards: Card[]; buttons: TemplateButtonInput[] }) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-ink-500">Aperçu WhatsApp</p>
      <div className="overflow-hidden rounded-2xl border border-ink-200 shadow-sm">
        <div className="flex items-center gap-2 bg-[#075E54] px-3 py-2 text-white">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20 text-sm">🏢</div>
          <div className="leading-tight">
            <div className="text-sm font-medium">Messaging Me Tech</div>
            <div className="text-[10px] text-white/70">en ligne</div>
          </div>
        </div>
        <div className="space-y-2 px-3 py-4" style={{ backgroundColor: '#efeae2' }}>
          <div className="max-w-[88%] rounded-lg rounded-tl-none bg-white px-2.5 py-1.5 text-[13px] leading-snug text-ink-800 shadow-sm">
            {body.trim() ? <span className="whitespace-pre-wrap break-words">{body}</span> : <span className="text-ink-400">Message d&apos;introduction…</span>}
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {cards.map((c, i) => (
              <div key={i} className="w-44 shrink-0 overflow-hidden rounded-lg bg-white shadow-sm">
                <div className="flex aspect-video w-full items-center justify-center bg-ink-100 text-[11px] text-ink-400">
                  {c.preview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.preview} alt={`Carte ${i + 1}`} className="h-full w-full object-cover" />
                  ) : (
                    'image'
                  )}
                </div>
                {c.body.trim() && <div className="px-2 py-1.5 text-[12px] leading-snug text-ink-800">{c.body}</div>}
                {buttons.length > 0 && (
                  <div>
                    {buttons.map((b, j) => (
                      <div key={j} className="border-t border-ink-100 py-1.5 text-center text-[12px] font-medium text-[#00a5f4]">
                        {b.text?.trim() || (b.type === 'URL' ? 'Lien' : 'Réponse')}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Éditeur de template CAROUSEL : corps commun + 2 à 10 cartes (image + texte), boutons identiques
 *  sur toutes les cartes (contrainte Meta). Les images sont uploadées à la sélection (handle Meta). */
export function CarouselForm({ tenantId, onCreated }: { tenantId: string; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [cards, setCards] = useState<Card[]>([emptyCard(), emptyCard()]);
  const [buttons, setButtons] = useState<TemplateButtonInput[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const fileRefs = useRef<Array<HTMLInputElement | null>>([]);

  function setCard(i: number, patch: Partial<Card>) {
    setCards((list) => list.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  }
  function addCard() {
    setCards((list) => (list.length < 10 ? [...list, emptyCard()] : list));
  }
  function removeCard(i: number) {
    setCards((list) => (list.length > 2 ? list.filter((_, j) => j !== i) : list));
  }

  async function onFile(i: number, file: File | undefined) {
    if (!file) return;
    setCard(i, { uploading: true, error: undefined });
    try {
      const dataUrl = await resizeToDataUrl(file);
      const { handle } = await uploadMedia(tenantId, dataUrl);
      setCard(i, { headerHandle: handle, preview: dataUrl, uploading: false });
    } catch (err) {
      setCard(i, { uploading: false, error: err instanceof Error ? err.message : 'Upload impossible' });
    }
  }

  const buttonsComplete = buttons.every((b) => b.text.trim() !== '' && (b.type !== 'URL' || (b.url ?? '').trim() !== ''));
  const canSubmit =
    name.trim() !== '' && body.trim() !== '' && cards.length >= 2 && cards.every((c) => c.headerHandle !== '' && !c.uploading) && buttonsComplete && !busy;

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await createTemplate(tenantId, {
        name: name.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'),
        category: 'MARKETING',
        language: 'fr',
        body: body.trim(),
        carousel: {
          cards: cards.map((c) => ({
            headerHandle: c.headerHandle,
            ...(c.body.trim() ? { body: c.body.trim() } : {}),
            ...(buttons.length > 0 ? { buttons } : {}),
          })),
        },
      });
      setMsg({ kind: 'ok', text: `Carousel soumis (statut : ${res.status}). Il passe en revue Meta.` });
      setName('');
      setBody('');
      setCards([emptyCard(), emptyCard()]);
      setButtons([]);
      onCreated();
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Création impossible' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
      <div>
        <label className="mb-1 block text-xs font-medium text-ink-600">Nom du carousel</label>
        <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputCls} w-full max-w-sm`} placeholder="promo_selection" />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-ink-600">Message d&apos;introduction (commun)</label>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} className={`${inputCls} w-full`} placeholder="Découvrez notre sélection du moment." />
      </div>

      {/* Boutons communs à toutes les cartes */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <label className="text-xs font-medium text-ink-600">Boutons (identiques sur chaque carte)</label>
          <div className="flex gap-2 text-xs">
            <button type="button" onClick={() => setButtons([...buttons, { type: 'QUICK_REPLY', text: '' }])} className="text-brand-600 hover:underline">+ réponse rapide</button>
            <button type="button" onClick={() => setButtons([...buttons, { type: 'URL', text: '', url: '' }])} className="text-brand-600 hover:underline">+ lien</button>
          </div>
        </div>
        <div className="space-y-2">
          {buttons.map((b, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="w-16 shrink-0 text-xs text-ink-400">{b.type === 'URL' ? 'lien' : 'réponse'}</span>
              <input value={b.text} onChange={(e) => setButtons(buttons.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} className={`${inputCls} flex-1`} placeholder="Texte du bouton" />
              {b.type === 'URL' && (
                <input value={b.url ?? ''} onChange={(e) => setButtons(buttons.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} className={`${inputCls} w-28`} placeholder="https://..." />
              )}
              <button type="button" onClick={() => setButtons(buttons.filter((_, j) => j !== i))} className="shrink-0 text-ink-400 hover:text-red-600" aria-label="Retirer">×</button>
            </div>
          ))}
        </div>
      </div>

      {/* Cartes */}
      <div className="space-y-3">
        <div className="text-xs font-medium text-ink-600">Cartes ({cards.length}/10) — 2 minimum</div>
        <div className="grid gap-3 sm:grid-cols-2">
          {cards.map((c, i) => (
            <div key={i} className="space-y-2 rounded-xl border border-ink-200 p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-ink-500">Carte {i + 1}</span>
                <button type="button" onClick={() => removeCard(i)} disabled={cards.length <= 2} className="text-xs text-ink-400 hover:text-coral disabled:opacity-40" title="Retirer">Retirer</button>
              </div>
              <button
                type="button"
                onClick={() => fileRefs.current[i]?.click()}
                disabled={c.uploading}
                className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg border border-dashed border-ink-300 bg-ink-50 text-xs text-ink-400 hover:border-brand-400 disabled:cursor-not-allowed"
              >
                {c.uploading ? (
                  'Upload…'
                ) : c.preview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.preview} alt={`Carte ${i + 1}`} className="h-full w-full object-cover" />
                ) : (
                  'Choisir une image'
                )}
              </button>
              <input
                ref={(el) => { fileRefs.current[i] = el; }}
                type="file"
                accept="image/png,image/jpeg"
                className="hidden"
                onChange={(e) => onFile(i, e.target.files?.[0])}
              />
              {c.error && <p className="text-xs text-coral">{c.error}</p>}
              <input value={c.body} onChange={(e) => setCard(i, { body: e.target.value })} className={`${inputCls} w-full`} placeholder="Texte de la carte (optionnel)" />
            </div>
          ))}
        </div>
        <button type="button" onClick={addCard} disabled={cards.length >= 10} className="text-sm font-medium text-brand-600 hover:text-brand-700 disabled:opacity-40">+ Ajouter une carte</button>
      </div>

      <CarouselPreview body={body} cards={cards} buttons={buttons} />

      {msg && <p className={`rounded-lg px-3 py-2 text-sm ${msg.kind === 'ok' ? 'bg-mint-50 text-mint-700' : 'bg-red-50 text-red-700'}`}>{msg.text}</p>}
      <button onClick={submit} disabled={!canSubmit} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-60">
        {busy ? 'Création…' : 'Créer le carousel'}
      </button>
    </div>
  );
}
