'use client';

import { useRef, useState } from 'react';
import { createRcsMessage, updateRcsMessage, type UserFieldDef } from '@/lib/api';
import {
  carteVide, carrouselVide, manquesCarrousel, versCarrouselRcs, MAX_CARTES, MIN_CARTES, MAX_TEXTE_CARTE,
  MAX_TITRE_CARTE, type BrouillonCarrouselRcs, type CarteBrouillon,
} from '@/lib/rcs-carrousel';
import { MAX_BOUTONS_CARTE } from '@/lib/rcs';
import { RcsButtonsEditor } from '@/components/RcsButtonsEditor';
import { ChampImageHebergee } from '@/components/ChampImageHebergee';
import { ChampCorpsVariables } from '@/components/ChampCorpsVariables';
import { RcsCarouselPreview } from '@/components/RcsCarouselPreview';
import { RcsPhoneFrame } from '@/components/RcsPhoneFrame';
import { ListeManques } from '@/components/ListeManques';
import { useT } from '@/lib/i18n';
import { inputClsAuto } from '@/lib/ui';
import { Bouton } from '@/components/Bouton';

/** Un carrousel qu'on modifie : son identifiant, son nom, et son contenu déjà relu en brouillon. */
export interface CarrouselInitial {
  id: string;
  name: string;
  brouillon: BrouillonCarrouselRcs;
}

/** Une carte en cours d'édition, avec une CLÉ STABLE (cf. `majCarte`). */
type CarteEdition = CarteBrouillon & { cle: number };

/**
 * L'ÉDITEUR D'UN CARROUSEL RCS, sur le dessin de `CarouselForm` (le carousel des templates WhatsApp) : le nom,
 * les cartes en grille avec la tuile « + Ajouter une carte », l'aperçu en dessous, ce qui manque, le bouton.
 *
 * ⚠️ UNE DIFFÉRENCE AVEC WHATSAPP, ET ELLE EST VOULUE : les boutons se règlent CARTE PAR CARTE. Meta exige la
 * même disposition sur toutes les cartes d'un carousel ; le RCS, non. Recopier la disposition commune de
 * `CarouselForm` serait inventer une contrainte que le canal n'a pas.
 *
 * Ce qui part est `versCarrouselRcs`, et le bouton est grisé si et seulement si `manquesCarrousel` n'est pas
 * vide : la même liste décide du bouton et de ce qu'on affiche.
 */
export function RcsCarouselForm({ tenantId, fields, initial, onSaved }: {
  tenantId: string;
  fields: UserFieldDef[];
  initial?: CarrouselInitial;
  onSaved: () => void;
}) {
  const t = useT();
  const prochaineCle = useRef(0);
  const avecCle = (c: CarteBrouillon): CarteEdition => ({ ...c, cle: prochaineCle.current++ });
  const [nom, setNom] = useState(initial?.name ?? '');
  const [cartes, setCartes] = useState<CarteEdition[]>(() => (initial?.brouillon ?? carrouselVide()).cartes.map(avecCle));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * 🔴 PAR CLÉ, JAMAIS PAR RANG. Un téléversement dure une seconde ou deux : retirer la carte 1 pendant que le
   * visuel de la carte 3 monte décale les rangs, et une mise à jour par rang poserait l'image sur la mauvaise
   * carte. La clé suit la carte, le rang ne la suit pas.
   */
  const majCarte = (cle: number, patch: Partial<CarteBrouillon>) =>
    setCartes((l) => l.map((c) => (c.cle === cle ? { ...c, ...patch } : c)));
  const ajouterCarte = () => setCartes((l) => (l.length < MAX_CARTES ? [...l, avecCle(carteVide())] : l));
  const retirerCarte = (cle: number) => setCartes((l) => (l.length > MIN_CARTES ? l.filter((c) => c.cle !== cle) : l));

  const brouillon: BrouillonCarrouselRcs = { cartes };
  const manques = manquesCarrousel(nom, brouillon).map((m) => t(...m));
  const canSubmit = manques.length === 0 && !busy;

  async function enregistrer() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const contenu = versCarrouselRcs(brouillon);
      if (initial) await updateRcsMessage(tenantId, initial.id, nom.trim(), contenu);
      else await createRcsMessage(tenantId, nom.trim(), contenu);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Enregistrement impossible', 'Save failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 rounded-2xl border border-ink-200 bg-white p-5">
      <div>
        <label className="mb-1 block text-xs font-medium text-ink-500">{t('Nom du carrousel (interne)', 'Carousel name (internal)')}</label>
        <input
          value={nom}
          onChange={(e) => setNom(e.target.value)}
          maxLength={120}
          data-testid="rcs-carrousel-nom"
          className={`${inputClsAuto} w-full max-w-sm`}
          placeholder={t('Sélection de la rentrée', 'Back-to-school selection')}
        />
      </div>

      <div className="space-y-3">
        <div className="text-xs font-medium text-ink-500">
          {t('Cartes', 'Cards')} ({cartes.length}/{MAX_CARTES}, {t('2 minimum', 'min. 2')})
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="grid flex-1 gap-3 sm:grid-cols-2">
            {cartes.map((c, i) => (
              <div key={c.cle} data-testid={`rcs-carte-${i}`} className="min-w-0 space-y-2 rounded-xl border border-ink-200 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-ink-500">{t('Carte', 'Card')} {i + 1}</span>
                  <button
                    type="button"
                    onClick={() => retirerCarte(c.cle)}
                    disabled={cartes.length <= MIN_CARTES}
                    data-testid={`rcs-carte-${i}-retirer`}
                    className="text-xs text-ink-400 hover:text-danger disabled:opacity-40"
                  >
                    {t('Retirer', 'Remove')}
                  </button>
                </div>
                <ChampImageHebergee
                  tenantId={tenantId}
                  valeur={c.imageUrl}
                  onChange={(imageUrl) => majCarte(c.cle, { imageUrl })}
                  testIdPrefix={`rcs-carte-${i}`}
                  apparence="tuile"
                  compact
                />
                <input
                  value={c.title}
                  onChange={(e) => majCarte(c.cle, { title: e.target.value })}
                  maxLength={MAX_TITRE_CARTE}
                  data-testid={`rcs-carte-${i}-titre`}
                  className={`${inputClsAuto} w-full`}
                  placeholder={t('Titre de la carte (facultatif)', 'Card title (optional)')}
                />
                {/* Le libellé porte le compteur sur SA ligne : sans lui, « 16 / 2000 » flotte sous le titre et
                    se lit comme le compteur du titre. */}
                <ChampCorpsVariables
                  valeur={c.text}
                  onChange={(text) => majCarte(c.cle, { text })}
                  fields={fields}
                  label={t('Texte', 'Text')}
                  placeholder={t('Texte de la carte', 'Card text')}
                  testId={`rcs-carte-${i}-texte`}
                  max={MAX_TEXTE_CARTE}
                  compact
                />
                <RcsButtonsEditor
                  boutons={c.suggestions}
                  onChange={(suggestions) => majCarte(c.cle, { suggestions })}
                  max={MAX_BOUTONS_CARTE}
                  dateFields={fields}
                  testIdPrefix={`rcs-carte-${i}`}
                  compact
                />
              </div>
            ))}
          </div>
          {/* La tuile de `CarouselForm`, à droite des cartes, pleine hauteur. */}
          <button
            type="button"
            onClick={ajouterCarte}
            disabled={cartes.length >= MAX_CARTES}
            data-testid="rcs-carrousel-ajouter-carte"
            className="flex w-full shrink-0 flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-brand-200 px-4 py-6 text-brand-600 transition-colors duration-150 hover:border-brand-400 hover:bg-brand-50 disabled:opacity-40 sm:w-40"
          >
            <span className="text-2xl leading-none">+</span>
            <span className="text-sm font-medium">{t('+ Ajouter une carte', '+ Add a card')}</span>
          </button>
        </div>
      </div>

      <RcsPhoneFrame>
        <RcsCarouselPreview brouillon={brouillon} sansFond />
      </RcsPhoneFrame>

      {error && <p className="rounded-lg bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</p>}
      <ListeManques manques={manques} testId="rcs-carrousel-manques" busy={busy} />
      <Bouton
        type="button"
        onClick={() => void enregistrer()}
        disabled={!canSubmit}
        data-testid="rcs-carrousel-enregistrer"
      >
        {busy ? t('Enregistrement…', 'Saving…') : initial ? t('Enregistrer les modifications', 'Save changes') : t('Créer le carrousel', 'Create carousel')}
      </Bouton>
    </div>
  );
}
