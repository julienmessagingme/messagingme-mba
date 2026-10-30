'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { listerMediatheque, type FichierMediatheque } from '@/lib/api';
import { fichierAccepte, type Accepte } from '@/lib/champ-fichier';
import { imageDessinable } from '@/lib/image-dessinable';
import { poids } from '@/lib/medias';
import { useT } from '@/lib/i18n';
import { Modale } from '@/components/Modale';
import { Squelette } from '@/components/Squelette';

/**
 * CHOISIR UN FICHIER DÉJÀ DANS LA MÉDIATHÈQUE (Julien, 2026-10-30 : « quand je veux rajouter une photo dans un node dans
 * un scénario, je dois pouvoir choisir si ça vient de la médiathèque ou si ça vient du PC »). Elle s'ouvre depuis le champ
 * d'image PARTAGÉ (`ChampImageHebergee`), donc elle vaut pour chaque écran qui en porte un, blocs de scénario compris.
 *
 * 🔴 ELLE REND L'ADRESSE QUE REND UN DÉPÔT, ET RIEN D'AUTRE : le champ stocke une adresse, que le fichier vienne du poste
 * ou d'ici. Aucun second format de stockage, donc rien de neuf pour les envois ni pour le refus de suppression d'un
 * fichier utilisé, qui retrouve ses contenus par cette même adresse.
 *
 * ⚠️ ELLE NE PROPOSE QUE CE QUE LE CHAMP PEUT ENVOYER (`fichierAccepte`) : un GIF ne s'offre pas au bloc « message rapide »,
 * que WhatsApp refuserait à l'envoi, loin de l'écran où on l'aurait choisi.
 *
 * ⚠️ DANS UN PORTAIL, parce que le champ vit parfois DANS une autre fenêtre (l'éditeur de scénario ouvert depuis une
 * campagne) : rendue sur place, elle hériterait du cadre et du défilement de celle-ci.
 */
export function ChoixMediatheque({ tenantId, accepte, testIdPrefix, onChoisir, onClose }: {
  tenantId: string;
  accepte: Accepte;
  /** Le préfixe du champ qui l'ouvre : deux champs du même écran ne doivent pas partager leurs `data-testid`. */
  testIdPrefix: string;
  onChoisir: (url: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [fichiers, setFichiers] = useState<FichierMediatheque[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    let vivant = true;
    listerMediatheque(tenantId)
      // Normalisé AVANT d'entrer dans l'état : une réponse sans `fichiers` ferait jeter le rendu sur un `.filter`.
      .then((m) => { if (vivant) setFichiers(Array.isArray(m?.fichiers) ? m.fichiers : []); })
      .catch((e: unknown) => {
        if (vivant) setErreur(e instanceof Error ? e.message : t('La médiathèque n’a pas pu être lue.', 'The media library could not be read.'));
      });
    return () => { vivant = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  const proposables = (fichiers ?? []).filter((f) => fichierAccepte(f, accepte));
  const formats = accepte === 'image'
    ? t('images JPEG, PNG ou GIF', 'JPEG, PNG or GIF images')
    : accepte === 'image-video-pdf'
      ? t('images JPEG ou PNG, vidéos MP4 ou PDF', 'JPEG or PNG images, MP4 videos or PDFs')
      : t('images, vidéos MP4 ou PDF', 'images, MP4 videos or PDFs');

  return createPortal(
    <Modale
      titre={t('Choisir dans la médiathèque', 'Pick from the media library')}
      sousTitre={t(`Ce champ accepte les ${formats}.`, `This field accepts ${formats}.`)}
      testId={`${testIdPrefix}-mediatheque`}
      testIdFermer={`${testIdPrefix}-mediatheque-fermer`}
      onClose={onClose}
    >
      {erreur ? (
        <p className="rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700" data-testid={`${testIdPrefix}-mediatheque-erreur`}>{erreur}</p>
      ) : fichiers === null ? (
        <Squelette forme="lignes" />
      ) : proposables.length === 0 ? (
        <p className="text-sm text-ink-500" data-testid={`${testIdPrefix}-mediatheque-vide`}>
          {fichiers.length === 0
            ? t('La médiathèque est encore vide. Déposez un fichier depuis votre ordinateur, ou depuis Paramètres > Médiathèque.', 'The media library is still empty. Upload a file from your computer, or from Settings > Media library.')
            : t('Aucun fichier de la médiathèque ne convient à ce champ.', 'No file in the media library fits this field.')}
        </p>
      ) : (
        <ul className="divide-y divide-ink-100">
          {proposables.map((f) => {
            const vignette = f.mime.startsWith('image/') ? imageDessinable(f.url) : null;
            return (
              <li key={f.code}>
                <button
                  type="button"
                  onClick={() => { onChoisir(f.url); onClose(); }}
                  data-testid={`${testIdPrefix}-mediatheque-fichier`}
                  className="flex w-full items-center gap-3 rounded-controle px-2 py-2 text-left hover:bg-ink-50"
                >
                  {vignette !== null ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={vignette} alt="" referrerPolicy="no-referrer" className="h-10 w-10 shrink-0 rounded-controle border border-ink-200 object-cover" />
                  ) : (
                    // Une vidéo ou un PDF n'ont pas d'adresse publique, donc pas de vignette : le genre se dit en toutes lettres.
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-controle border border-ink-200 bg-ink-50 text-[10px] font-semibold text-ink-700">
                      {f.mime === 'video/mp4' ? t('Vidéo', 'Video') : f.mime === 'application/pdf' ? 'PDF' : t('Image', 'Image')}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-900">{f.nom ?? f.code}</span>
                  <span className="shrink-0 text-xs tabular-nums text-ink-500">{poids(f.taille)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Modale>,
    document.body,
  );
}
