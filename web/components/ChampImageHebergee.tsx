'use client';

import { useRef, useState } from 'react';
import { uploadRcsMedia } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { Bouton } from '@/components/Bouton';

/**
 * Une image que la console HÉBERGE : on choisit un fichier, et l'adresse publique se remplit toute seule.
 *
 * 🔴 POURQUOI CE CHAMP NE PEUT PAS ÊTRE UN SIMPLE SÉLECTEUR DE FICHIER, et pourquoi le même besoin revient
 * partout. Ni un message RCS ni un post de chaîne WhatsApp ne TRANSPORTENT l'image : ils transportent son
 * ADRESSE, que l'opérateur télécom ou le fournisseur de chaîne va chercher lui-même. Il faut donc une URL
 * publique, et c'est exactement ce que personne ne veut avoir à fabriquer. Le champ garde malgré tout la
 * saisie d'une adresse, pour le client qui héberge déjà ses visuels ailleurs et veut garder son CDN.
 *
 * Le fichier est envoyé en data URL base64 : le serveur relit sa SIGNATURE (un `.png` renommé est refusé) et
 * c'est le type réel qui décide de l'extension de l'adresse rendue.
 *
 * ⚠️ IL S'APPELAIT `RcsImageField`, ET LE RESTE DU CHEMIN GARDE SON NOM RCS : la fonction d'appel est
 * `uploadRcsMedia`, la route `POST /tenants/:id/rcs/media`, la table `rcs_media`, le service public
 * `GET /m/:fichier`. Ce n'est pas un demi-renommage oublié, c'est une porte à SENS UNIQUE : `/m/` sert des
 * adresses parties dans des messages RCS déjà livrés, la renommer les casserait toutes, et renommer une
 * table n'achète rien. Seul le composant est renommé, parce que c'est le seul des cinq qu'un développeur
 * lit avant de décider s'il peut s'en servir.
 */

/** Extensions acceptées par l'opérateur RCS. Contrôlé ICI aussi parce qu'un `.webp` passe la validation
 *  d'URL et se fait refuser à l'ENVOI, c'est-à-dire devant un client. */
const IMAGE_RE = /\.(jpe?g|png|gif)(\?.*)?$/i;
const TAILLE_MAX = 2 * 1024 * 1024;

export function ChampImageHebergee({
  tenantId, valeur, onChange, testIdPrefix = 'rcs-message', compact = false, avertirExtension = true, apparence = 'ligne',
}: {
  tenantId: string;
  valeur: string;
  onChange: (url: string) => void;
  testIdPrefix?: string;
  compact?: boolean;
  /**
   * L'avertissement « cette adresse ne finit pas par .jpg » est une règle de l'OPÉRATEUR RCS, mesurée chez
   * lui. 🔴 Le mettre ailleurs serait inventer une contrainte : la spec de Channels Me dit « an image, video
   * or document » et ne nomme aucune extension. On n'avertit que là où on a mesuré.
   */
  avertirExtension?: boolean;
  /**
   * `tuile` : la zone pointillée « Choisir une image » des cartes de `CarouselForm`, avec le visuel dedans une
   * fois posé. C'est le dessin des cartes d'un carrousel RCS, qui doivent ressembler à celles d'un carousel
   * WhatsApp (Julien, 2026-09-21). `ligne` (défaut) : le bouton et la vignette, INCHANGÉS, parce que les
   * autres écrans et leurs specs visent ce rendu-là.
   */
  apparence?: 'ligne' | 'tuile';
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const fichierRef = useRef<HTMLInputElement>(null);
  const cls = compact ? `${inputCls} bg-white` : inputCls;

  async function televerser(file: File) {
    setErreur(null);
    // Poids vérifié AVANT la lecture : inutile d'encoder 20 Mo en base64 pour se les faire refuser ensuite.
    if (file.size > TAILLE_MAX) {
      setErreur(t('Image trop lourde : 2 Mo maximum.', 'Image too large: 2 MB maximum.'));
      return;
    }
    setBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const lecteur = new FileReader();
        lecteur.onload = () => resolve(String(lecteur.result ?? ''));
        lecteur.onerror = () => reject(new Error('lecture impossible'));
        lecteur.readAsDataURL(file);
      });
      const r = await uploadRcsMedia(tenantId, dataUrl, file.name);
      onChange(r.url);
    } catch (e) {
      // Le message vient du serveur et NOMME la cause (format refusé, trop lourd) : on l'affiche tel quel.
      setErreur(e instanceof Error ? e.message : t('Téléversement impossible', 'Upload failed'));
    } finally {
      setBusy(false);
      // Remis à zéro : sans ça, re-choisir LE MÊME fichier après une erreur n'émet aucun événement.
      if (fichierRef.current) fichierRef.current.value = '';
    }
  }

  const douteuse = avertirExtension && valeur.trim() !== '' && !IMAGE_RE.test(valeur.trim());
  const aUneImage = valeur.trim() !== '';

  const retirer = (
    <button
      type="button"
      onClick={() => { onChange(''); setErreur(null); }}
      data-testid={`${testIdPrefix}-image-clear`}
      className="shrink-0 text-sm text-ink-500 hover:text-danger"
    >
      {t('Retirer', 'Remove')}
    </button>
  );
  const champAdresse = (classe: string) => (
    <input
      value={valeur}
      onChange={(e) => onChange(e.target.value)}
      data-testid={`${testIdPrefix}-image`}
      className={classe}
      placeholder={t('…ou collez l’adresse d’une image déjà en ligne', '…or paste the URL of an image already online')}
    />
  );

  return (
    <div>
      {apparence === 'tuile' ? (
        // La zone pointillée des cartes de `CarouselForm` : le visuel s'affiche DEDANS une fois posé.
        <button
          type="button"
          onClick={() => fichierRef.current?.click()}
          disabled={busy}
          data-testid={`${testIdPrefix}-image-upload`}
          className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-controle border border-dashed border-ink-300 bg-ink-50 text-xs text-ink-500 hover:border-brand-400 disabled:cursor-not-allowed"
        >
          {busy ? t('Envoi…', 'Uploading…') : aUneImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={valeur.trim()} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
          ) : t('Choisir une image', 'Choose an image')}
        </button>
      ) : (
        <div className="flex items-center gap-2">
          <Bouton variante="secondaire" enCours={busy}
            type="button"
            onClick={() => fichierRef.current?.click()}
            disabled={busy}
            data-testid={`${testIdPrefix}-image-upload`}
            className="shrink-0"
          >
            {busy ? t('Envoi…', 'Uploading…') : t('Choisir une image', 'Choose an image')}
          </Bouton>
          {aUneImage && (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={valeur.trim()}
                alt=""
                referrerPolicy="no-referrer"
                className="h-9 w-14 shrink-0 rounded-controle border border-ink-200 bg-ink-50 object-cover"
              />
              {retirer}
            </>
          )}
        </div>
      )}
      <input
        ref={fichierRef}
        type="file"
        accept="image/jpeg,image/png,image/gif"
        data-testid={`${testIdPrefix}-image-file`}
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void televerser(f); }}
      />

      {apparence === 'tuile' ? (
        <div className="mt-1.5 flex items-center gap-2">
          {champAdresse(cls)}
          {aUneImage && retirer}
        </div>
      ) : champAdresse(`${cls} mt-1.5`)}

      {erreur && <p className="mt-1 text-xs text-danger-700" data-testid={`${testIdPrefix}-image-error`}>{erreur}</p>}
      {douteuse && (
        <p className="mt-1 text-xs text-alerte-700" data-testid={`${testIdPrefix}-image-warn`}>
          {t('Cette adresse ne finit pas par .jpg, .png ou .gif : l’opérateur refusera l’envoi.', 'This URL does not end in .jpg, .png or .gif: the carrier will refuse the send.')}
        </p>
      )}
    </div>
  );
}
