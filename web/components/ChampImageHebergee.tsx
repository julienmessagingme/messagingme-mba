'use client';

import { useRef, useState } from 'react';
import { imageDessinable } from '@/lib/image-dessinable';
import { typesAcceptes, extensionDouteuse, genreDeLAdresse, refusAvantEnvoi, type Accepte } from '@/lib/champ-fichier';
import { deposerDansLaMediatheque } from '@/lib/depot-mediatheque';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { Bouton } from '@/components/Bouton';
import { ChoixMediatheque } from '@/components/ChoixMediatheque';

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

/** Les types, plafonds et extensions acceptés vivent dans `lib/champ-fichier.ts`, testés : une extension refusée à
 *  l'ENVOI (un `.webp` pour l'opérateur RCS) l'est devant un client, donc on avertit dès la saisie. */

export function ChampImageHebergee({
  tenantId, valeur, onChange, testIdPrefix = 'rcs-message', compact = false, avertirExtension = true, apparence = 'ligne', accepte = 'image',
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
  /**
   * Ce que le champ accepte (spec médias, § 3.6) : `image` (défaut, tous les écrans RCS et de campagne) ou
   * `image-video-pdf`, le bloc « message rapide », qui part en WhatsApp (JPEG, PNG, MP4, PDF, sans GIF).
   */
  accepte?: Accepte;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  /** La fenêtre « Choisir dans la médiathèque » (Julien, 2026-10-30) : le fichier vient du poste OU de la médiathèque. */
  const [mediatheque, setMediatheque] = useState(false);
  const fichierRef = useRef<HTMLInputElement>(null);
  const cls = compact ? `${inputCls} bg-white` : inputCls;

  async function televerser(file: File) {
    setErreur(null);
    // Type et poids vérifiés AVANT la lecture, par la règle que partage le bouton « Ajouter » de la Médiathèque.
    const refus = refusAvantEnvoi(file, accepte, t);
    if (refus) {
      setErreur(refus);
      return;
    }
    setBusy(true);
    try {
      const r = await deposerDansLaMediatheque(tenantId, file);
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

  const douteuse = avertirExtension && extensionDouteuse(valeur, accepte);
  const aUneImage = valeur.trim() !== '';
  // Une vidéo ou un PDF n'ont pas de vignette (leur adresse n'est pas publique) : le genre se dit en toutes lettres.
  const genre = genreDeLAdresse(valeur);
  // La vignette ne se dessine que pour une adresse https (`imageDessinable`) ; une autre garde son bouton « Retirer ».
  const vignette = genre === 'image' ? imageDessinable(valeur) : null;
  const choisir = accepte === 'image' ? t('Choisir une image', 'Choose an image') : t('Choisir un fichier', 'Choose a file');
  /**
   * 🔴 LE SECOND CHOIX DE LA SOURCE : « Choisir une image » ouvre le poste, ce bouton-ci la médiathèque. Le premier garde
   * son libellé, que la fiche d'aide publique de la Chaîne cite mot pour mot (« publier sur ma chaîne WhatsApp »).
   */
  const depuisLaMediatheque = (
    <Bouton variante="secondaire"
      type="button"
      onClick={() => setMediatheque(true)}
      disabled={busy}
      data-testid={`${testIdPrefix}-image-mediatheque`}
      className="shrink-0"
    >
      {t('Depuis la médiathèque', 'From the media library')}
    </Bouton>
  );

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
      placeholder={accepte === 'image'
        ? t('…ou collez l’adresse d’une image déjà en ligne', '…or paste the URL of an image already online')
        : t('…ou collez l’adresse d’un fichier déjà en ligne', '…or paste the URL of a file already online')}
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
          {busy ? t('Envoi…', 'Uploading…') : vignette !== null ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={vignette} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
          ) : choisir}
        </button>
      ) : (
        // ⚠️ `flex-wrap` : dans le panneau d'un bloc de scénario (~300 px), les deux boutons, la vignette et « Retirer »
        // ne tiennent pas sur une ligne ; sans retour à la ligne, le dernier sortirait du panneau.
        <div className="flex flex-wrap items-center gap-2">
          <Bouton variante="secondaire" enCours={busy}
            type="button"
            onClick={() => fichierRef.current?.click()}
            disabled={busy}
            data-testid={`${testIdPrefix}-image-upload`}
            className="shrink-0"
          >
            {busy ? t('Envoi…', 'Uploading…') : choisir}
          </Bouton>
          {depuisLaMediatheque}
          {aUneImage && (
            <>
              {genre !== 'image' && (
                <span className="shrink-0 text-sm text-ink-700" data-testid={`${testIdPrefix}-fichier-genre`}>
                  {genre === 'video' ? t('Vidéo jointe', 'Video attached') : t('PDF joint', 'PDF attached')}
                </span>
              )}
              {vignette !== null && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={vignette}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="h-9 w-14 shrink-0 rounded-controle border border-ink-200 bg-ink-50 object-cover"
                />
              )}
              {retirer}
            </>
          )}
        </div>
      )}
      <input
        ref={fichierRef}
        type="file"
        accept={typesAcceptes(accepte)}
        data-testid={`${testIdPrefix}-image-file`}
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void televerser(f); }}
      />

      {apparence === 'tuile' ? (
        <>
          {/* La tuile entière ouvre le poste ; la médiathèque est un lien dessous, la carte étant trop étroite pour un bouton. */}
          <button
            type="button"
            onClick={() => setMediatheque(true)}
            disabled={busy}
            data-testid={`${testIdPrefix}-image-mediatheque`}
            className="mt-1 text-xs text-brand-600 hover:underline disabled:cursor-not-allowed"
          >
            {t('ou choisir dans la médiathèque', 'or pick from the media library')}
          </button>
          <div className="mt-1.5 flex items-center gap-2">
            {champAdresse(cls)}
            {aUneImage && retirer}
          </div>
        </>
      ) : champAdresse(`${cls} mt-1.5`)}

      {mediatheque && (
        <ChoixMediatheque
          tenantId={tenantId}
          accepte={accepte}
          testIdPrefix={testIdPrefix}
          onChoisir={(url) => { setErreur(null); onChange(url); }}
          onClose={() => setMediatheque(false)}
        />
      )}

      {erreur && <p className="mt-1 text-xs text-danger-700" data-testid={`${testIdPrefix}-image-error`}>{erreur}</p>}
      {douteuse && (
        <p className="mt-1 text-xs text-alerte-700" data-testid={`${testIdPrefix}-image-warn`}>
          {accepte === 'image'
            ? t('Cette adresse ne finit pas par .jpg, .png ou .gif : l’opérateur refusera l’envoi.', 'This URL does not end in .jpg, .png or .gif: the carrier will refuse the send.')
            : t('Cette adresse ne finit pas par .jpg, .png, .mp4 ou .pdf : l’envoi sera refusé.', 'This URL does not end in .jpg, .png, .mp4 or .pdf: the send will be refused.')}
        </p>
      )}
    </div>
  );
}
