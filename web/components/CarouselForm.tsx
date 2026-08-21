'use client';

import { useRef, useState } from 'react';
import { createTemplate, uploadMedia, type TemplateButtonInput } from '@/lib/api';
import { resizeToDataUrl } from '@/lib/image';
import { CarouselPreview } from '@/components/CarouselPreview';
import { useTemplateBody, TemplateBodyField, TemplateVariableExamples, unmappedVariablesMessage } from '@/components/TemplateBodyField';
import { isSendableButtonUrl } from '@/lib/button-url';
import { useT } from '@/lib/i18n';
import { inputClsAuto } from '@/lib/ui';

/** Type d'un bouton de carte. Meta n'accepte que ces deux-là dans un carousel. */
type CardButtonType = 'QUICK_REPLY' | 'URL';

/** Le contenu d'un bouton POUR UNE CARTE : son libellé, et sa destination si c'est un lien. */
interface CardButton {
  text: string;
  url: string;
}

interface Card {
  headerHandle: string;
  preview: string;
  body: string;
  uploading: boolean;
  error?: string;
  /** Un contenu par bouton de la disposition, dans le même ordre. */
  buttons: CardButton[];
}

const emptyCard = (buttonCount: number): Card => ({
  headerHandle: '', preview: '', body: '', uploading: false,
  buttons: Array.from({ length: buttonCount }, () => ({ text: '', url: '' })),
});

/**
 * Éditeur de template CAROUSEL : message d'introduction commun + 2 à 10 cartes (image, texte, boutons).
 *
 * Règle Meta, VÉRIFIÉE EN LIVE (sonde du 2026-08-11) : seule la DISPOSITION des boutons doit être identique
 * d'une carte à l'autre, c'est-à-dire leur nombre, leurs types et leur ordre. Meta refuse deux cartes qui
 * n'ont pas le même nombre ni la même combinaison de types. En revanche le LIBELLÉ et l'URL peuvent différer
 * carte par carte, et c'est tout l'intérêt d'un carousel : chaque carte pointe vers sa propre destination.
 * D'où ce découpage : la disposition se règle une fois en haut, le contenu se saisit dans chaque carte.
 */
export function CarouselForm({ tenantId, onCreated }: { tenantId: string; onCreated: () => void }) {
  const t = useT();
  const [name, setName] = useState('');
  // Message d'introduction : c'est le composant BODY du template, donc il porte les variables EXACTEMENT
  // comme un template classique (mêmes chips, mêmes exemples Meta, mêmes indices variable -> champ, même
  // résolution à l'envoi). Une carte, elle, reste littérale : rien ne stocke un mapping « variable de la
  // carte N -> champ », et `carouselSendBlocker` refuse à l'envoi une carte qui en contiendrait.
  const bodyState = useTemplateBody(tenantId);
  const { body } = bodyState;
  const [layout, setLayout] = useState<CardButtonType[]>([]);
  const [cards, setCards] = useState<Card[]>([emptyCard(0), emptyCard(0)]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const fileRefs = useRef<Array<HTMLInputElement | null>>([]);

  function setCard(i: number, patch: Partial<Card>) {
    setCards((list) => list.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  }
  function setCardButton(i: number, j: number, patch: Partial<CardButton>) {
    setCards((list) => list.map((c, ci) => (ci === i ? { ...c, buttons: c.buttons.map((b, bi) => (bi === j ? { ...b, ...patch } : b)) } : c)));
  }
  function addCard() {
    setCards((list) => (list.length < 10 ? [...list, emptyCard(layout.length)] : list));
  }
  function removeCard(i: number) {
    setCards((list) => (list.length > 2 ? list.filter((_, j) => j !== i) : list));
  }
  // Ajouter / retirer un bouton touche TOUTES les cartes en même temps : c'est la disposition, et Meta la
  // veut identique partout. Laisser dériver une seule carte ferait refuser le template entier à la création.
  function addButton(type: CardButtonType) {
    setLayout((l) => [...l, type]);
    setCards((list) => list.map((c) => ({ ...c, buttons: [...c.buttons, { text: '', url: '' }] })));
  }
  function removeButton(j: number) {
    setLayout((l) => l.filter((_, k) => k !== j));
    setCards((list) => list.map((c) => ({ ...c, buttons: c.buttons.filter((_, k) => k !== j) })));
  }

  async function onFile(i: number, file: File | undefined) {
    if (!file) return;
    setCard(i, { uploading: true, error: undefined });
    try {
      const dataUrl = await resizeToDataUrl(file);
      const { handle } = await uploadMedia(tenantId, dataUrl);
      setCard(i, { headerHandle: handle, preview: dataUrl, uploading: false });
    } catch (err) {
      setCard(i, { uploading: false, error: err instanceof Error ? err.message : t('Upload impossible', 'Upload failed') });
    }
  }

  /** Les boutons d'UNE carte, au format attendu par l'API (la disposition donne le type, la carte le contenu). */
  const cardButtonsFor = (c: Card): TemplateButtonInput[] =>
    layout.map((type, j) => {
      const b = c.buttons[j] ?? { text: '', url: '' };
      return type === 'URL'
        ? { type: 'URL' as const, text: b.text.trim(), url: b.url.trim() }
        : { type: 'QUICK_REPLY' as const, text: b.text.trim() };
    });

  // Chaque bouton de chaque carte doit être rempli : Meta refuse un libellé vide, et un carousel à moitié
  // saisi partirait en revue pour revenir refusé.
  const buttonsComplete = cards.every((c) =>
    layout.every((type, j) => {
      const b = c.buttons[j];
      return !!b && b.text.trim() !== '' && (type !== 'URL' || isSendableButtonUrl(b.url));
    }),
  );
  /** Une URL commencée mais pas valide : on le dit sous le champ plutôt que d'attendre le refus de Meta,
   *  dont le message désigne un chemin de tableau JSON, illisible. Champ vide = pas encore saisi, pas d'alerte. */
  const urlKo = (c: Card, j: number): boolean => {
    const v = c.buttons[j]?.url ?? '';
    return v.trim() !== '' && !isSendableButtonUrl(v);
  };
  const canSubmit =
    name.trim() !== '' && body.trim() !== '' && cards.length >= 2 && cards.every((c) => c.headerHandle !== '' && !c.uploading) && buttonsComplete && !busy;

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      // Même canonicalisation que pour un template classique : positions renumérotées 1..N sans trou (exigé
      // par Meta), exemples et indices réalignés dessus.
      const canon = bodyState.canonicalize();
      if (canon.unmapped.length > 0) {
        setMsg({ kind: 'err', text: unmappedVariablesMessage(canon.unmapped, t) });
        setBusy(false);
        return;
      }
      const res = await createTemplate(tenantId, {
        name: name.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'),
        category: 'MARKETING',
        language: 'fr',
        body: canon.body.trim(),
        ...(canon.example ? { example: canon.example } : {}),
        ...(canon.paramHints.length > 0 ? { paramHints: canon.paramHints } : {}),
        carousel: {
          cards: cards.map((c) => ({
            headerHandle: c.headerHandle,
            ...(c.body.trim() ? { body: c.body.trim() } : {}),
            ...(layout.length > 0 ? { buttons: cardButtonsFor(c) } : {}),
          })),
        },
      });
      setMsg({ kind: 'ok', text: `${t('Carousel soumis (statut :', 'Carousel submitted (status:')} ${res.status}). ${t('Il passe en revue Meta.', 'Now under Meta review.')}` });
      setName('');
      bodyState.reset();
      setCards([emptyCard(layout.length), emptyCard(layout.length)]);
      onCreated();
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : t('Création impossible', 'Creation failed') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
      <div>
        <label className="mb-1 block text-xs font-medium text-ink-600">{t('Nom du carousel', 'Carousel name')}</label>
        <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputClsAuto} w-full max-w-sm`} placeholder="promo_selection" />
      </div>
      <TemplateBodyField
        state={bodyState}
        label={t("Message d'introduction (commun)", 'Introduction message (shared)')}
        placeholder={t('Bonjour [Prénom], découvrez notre sélection 🎉', 'Hello [First name], discover our selection 🎉')}
        hint={t(
          "« + Variable » insère un champ du contact dans l'introduction, exactement comme sur un template classique. Le texte des CARTES, lui, est le même pour tout le monde.",
          '“+ Variable” inserts a contact field into the introduction, exactly like on a regular template. Card text, however, is the same for everyone.',
        )}
      />
      <TemplateVariableExamples state={bodyState} />

      {/* Boutons communs à toutes les cartes */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          {/* Libellé explicite : ces boutons sont COMMUNS aux cartes, et c'est ce que « Boutons de chaque
              carte » ne disait pas clairement. Le bloc reste EN HAUT à la demande de Julien : le descendre
              sous les cartes ferait apparaître les champs ajoutés hors du champ de vision. */}
          <label className="text-xs font-medium text-ink-600">{t('Boutons, identiques sur toutes les cartes', 'Buttons, the same on every card')}</label>
          <div className="flex gap-2 text-xs">
            <button type="button" onClick={() => addButton('QUICK_REPLY')} disabled={layout.length >= 2} className="text-brand-600 hover:underline disabled:opacity-40 disabled:no-underline">{t('+ réponse rapide', '+ quick reply')}</button>
            <button type="button" onClick={() => addButton('URL')} disabled={layout.length >= 2} className="text-brand-600 hover:underline disabled:opacity-40 disabled:no-underline">{t('+ lien', '+ link')}</button>
          </div>
        </div>
        {layout.length === 0 ? (
          <p className="text-xs text-ink-400">{t('Aucun bouton. Ajoute-en un : il apparaîtra sur toutes les cartes, et tu saisiras son texte et son lien carte par carte.', 'No button yet. Add one: it appears on every card, and you fill in its text and link card by card.')}</p>
        ) : (
          <div className="space-y-1.5">
            {layout.map((type, j) => (
              <div key={j} className="flex items-center gap-2 rounded-lg bg-ink-50 px-3 py-1.5">
                <span className="text-xs font-medium text-ink-600">{t('Bouton', 'Button')} {j + 1}</span>
                <span className="text-xs text-ink-500">{type === 'URL' ? t('lien', 'link') : t('réponse rapide', 'quick reply')}</span>
                <button type="button" onClick={() => removeButton(j)} className="ml-auto text-ink-400 hover:text-red-600" aria-label={t('Retirer', 'Remove')}>×</button>
              </div>
            ))}
            <p className="text-xs text-ink-400">
              {t('Meta exige la même disposition sur toutes les cartes (même nombre, mêmes types, même ordre). Le texte et le lien, eux, se saisissent carte par carte.', 'Meta requires the same layout on every card (same count, same types, same order). The text and link are filled in card by card.')}
            </p>
          </div>
        )}
      </div>

      {/* Cartes */}
      <div className="space-y-3">
        <div className="text-xs font-medium text-ink-600">{t('Cartes', 'Cards')} ({cards.length}/10, {t('2 minimum', 'min. 2')})</div>
        <div className="flex flex-col gap-3 sm:flex-row">
        <div className="grid flex-1 gap-3 sm:grid-cols-2">
          {cards.map((c, i) => (
            <div key={i} className="space-y-2 rounded-xl border border-ink-200 p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-ink-500">{t('Carte', 'Card')} {i + 1}</span>
                <button type="button" onClick={() => removeCard(i)} disabled={cards.length <= 2} className="text-xs text-ink-400 hover:text-coral disabled:opacity-40" title={t('Retirer', 'Remove')}>{t('Retirer', 'Remove')}</button>
              </div>
              <button
                type="button"
                onClick={() => fileRefs.current[i]?.click()}
                disabled={c.uploading}
                className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg border border-dashed border-ink-300 bg-ink-50 text-xs text-ink-400 hover:border-brand-400 disabled:cursor-not-allowed"
              >
                {c.uploading ? (
                  t('Upload…', 'Uploading…')
                ) : c.preview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.preview} alt={`${t('Carte', 'Card')} ${i + 1}`} className="h-full w-full object-cover" />
                ) : (
                  t('Choisir une image', 'Choose an image')
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
              <input value={c.body} onChange={(e) => setCard(i, { body: e.target.value })} className={`${inputClsAuto} w-full`} placeholder={t('Texte de la carte (optionnel)', 'Card text (optional)')} />
              {layout.map((type, j) => (
                <div key={j} className="space-y-1.5 rounded-lg bg-ink-50 p-2">
                  <div className="text-[11px] font-medium text-ink-500">
                    {t('Bouton', 'Button')} {j + 1} · {type === 'URL' ? t('lien', 'link') : t('réponse rapide', 'quick reply')}
                  </div>
                  <input
                    value={c.buttons[j]?.text ?? ''}
                    onChange={(e) => setCardButton(i, j, { text: e.target.value })}
                    maxLength={25}
                    className={`${inputClsAuto} w-full`}
                    placeholder={t('Texte du bouton (25 car. max)', 'Button text (25 char. max)')}
                  />
                  {type === 'URL' && (
                    <>
                      <input
                        value={c.buttons[j]?.url ?? ''}
                        onChange={(e) => setCardButton(i, j, { url: e.target.value })}
                        className={`${inputClsAuto} w-full ${urlKo(c, j) ? 'border-coral focus:border-coral focus:ring-red-100' : ''}`}
                        placeholder={t('https://exemple.fr/cette-carte', 'https://example.com/this-card')}
                      />
                      {urlKo(c, j) && (
                        <p className="text-[11px] text-coral">{t('Adresse incomplète : commence par https://', 'Incomplete address: start with https://')}</p>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
        {/* Tuile d'ajout à DROITE des cartes, pleine hauteur : le lien discret en bas de bloc se voyait mal.
            Convention « ajouter » du dépôt (pointillé brand), pas un second bouton plein qui se disputerait
            l'action principale avec « Créer le carousel ». Le libellé reste EXACTEMENT « + Ajouter une carte » :
            un test E2E le cible par son texte. */}
        <button
          type="button" onClick={addCard} disabled={cards.length >= 10} data-testid="carousel-ajouter-carte"
          className="flex w-full shrink-0 flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-brand-200 px-4 py-6 text-brand-600 transition hover:border-brand-400 hover:bg-brand-50 disabled:opacity-40 sm:w-40"
        >
          <span className="text-2xl leading-none">+</span>
          <span className="text-sm font-medium">{t('+ Ajouter une carte', '+ Add a card')}</span>
        </button>
        </div>
      </div>

      <CarouselPreview
        body={body}
        cards={cards.map((c) => ({ imageUrl: c.preview, body: c.body, buttons: cardButtonsFor(c) }))}
        buttons={[]}
        examples={bodyState.examples}
        varLabels={bodyState.varLabels}
      />

      {msg && <p className={`rounded-lg px-3 py-2 text-sm ${msg.kind === 'ok' ? 'bg-mint-50 text-mint-700' : 'bg-red-50 text-red-700'}`}>{msg.text}</p>}
      <button onClick={submit} disabled={!canSubmit} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-60">
        {busy ? t('Création…', 'Creating…') : t('Créer le carousel', 'Create carousel')}
      </button>
    </div>
  );
}
