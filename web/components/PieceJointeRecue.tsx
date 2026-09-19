'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { lireMediaMessage, type InboxMessage } from '@/lib/api';
import { ApiError } from '@/lib/http';
import {
  DUREE_MEDIA_RECU_JOURS_AFFICHEE, imageAffichable, nomDeTelechargement, type NaturePieceJointe,
} from '@/lib/piece-jointe';

/**
 * UNE PIÈCE JOINTE REÇUE DANS LE FIL : une photo affichée, un document ou une vidéo à télécharger
 * (2026-09-19, demande de Julien : « dans les conversations on doit pouvoir recevoir des photos... voire des
 * fichiers »).
 *
 * 🔴 AUCUN FICHIER REÇU N'EST OUVERT DANS L'ORIGINE DE LA CONSOLE autrement que par une `<img>`, qui n'exécute
 * rien. Un document porte le type que son EXPÉDITEUR annonce : ouvert dans un onglet depuis une URL `blob:`,
 * un HTML ou un SVG s'exécuterait avec l'origine de la console, donc lirait la session. Un téléchargement
 * part donc TOUJOURS en `application/octet-stream`, par un lien `download`, jamais par `window.open`.
 *
 * ⚠️ AUCUNE COPIE CHEZ NOUS (arbitrage de Julien) : passé le délai de WhatsApp, le fichier n'existe plus, et
 * l'écran le DIT au lieu d'afficher un bouton qui échouerait à chaque clic.
 *
 * ⚠️ UNE PHOTO SE CHARGE AU RENDU, un document ou une vidéo AU CLIC : on regarde une photo, on ne la
 * « lance » pas, alors qu'un PDF de dix méga ne doit partir que si on le demande.
 */
export function PieceJointeRecue({ tenantId, conversationId, message, nature, legende }: {
  tenantId: string;
  conversationId: string;
  message: InboxMessage;
  nature: NaturePieceJointe;
  /** La légende de l'expéditeur, ou `null`. Le libellé de type (`[image]`) n'en est pas une. */
  legende: string | null;
}) {
  const t = useT();
  const [expire, setExpire] = useState(message.mediaExpire === true);
  const [image, setImage] = useState<string | null>(null);
  /** Le blob reçu n'est pas une image qu'on accepte de rendre : on le propose au téléchargement. */
  const [imageRefusee, setImageRefusee] = useState(false);
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [agrandie, setAgrandie] = useState(false);

  const direExpire = t(
    `Fichier expiré : WhatsApp ne garde les pièces jointes que ${DUREE_MEDIA_RECU_JOURS_AFFICHEE} jours.`,
    `File expired: WhatsApp only keeps attachments for ${DUREE_MEDIA_RECU_JOURS_AFFICHEE} days.`,
  );

  /** Traduit un échec de lecture : « expiré » n'est pas une panne, et « trop lourd » dit sa taille. */
  function surEchec(err: unknown): void {
    if (err instanceof ApiError && err.status === 410) { setExpire(true); return; }
    setErreur(err instanceof ApiError && err.status === 422 ? err.message : t('Ce fichier n’a pas pu être récupéré.', 'This file could not be fetched.'));
  }

  useEffect(() => {
    if (nature !== 'image' || expire) return undefined;
    let vivant = true;
    let url: string | null = null;
    lireMediaMessage(tenantId, conversationId, message.id)
      .then((blob) => {
        if (!vivant) return;
        if (!imageAffichable(blob.type)) { setImageRefusee(true); return; }
        url = URL.createObjectURL(blob);
        setImage(url);
      })
      .catch((err: unknown) => { if (vivant) surEchec(err); });
    // Révoque l'URL d'objet au démontage : sans ça, chaque photo vue garde ses octets en mémoire du navigateur
    // jusqu'au rechargement de la page.
    return () => { vivant = false; if (url) URL.revokeObjectURL(url); };
    // `surEchec` et `t` ne changent pas le fichier à lire : les mettre en dépendance le rechargerait à
    // chaque rendu. Le fichier, lui, est désigné par ces trois identifiants.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, conversationId, message.id, nature]);

  async function telecharger(): Promise<void> {
    setOccupe(true); setErreur(null);
    try {
      const brut = await lireMediaMessage(tenantId, conversationId, message.id);
      // 🔴 RETYPÉ EN OCTETS BRUTS : un lien `download` ne rend rien, mais c'est le type qui décide de ce que
      // ferait un navigateur si le lien était un jour ouvert autrement. Le fichier ne s'exécute nulle part.
      const url = URL.createObjectURL(new Blob([brut], { type: 'application/octet-stream' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = nomDeTelechargement(message.mediaNom, nature, message.id);
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Révoquée APRÈS que le navigateur a pris le relais : tout de suite, certains navigateurs annulent
      // le téléchargement qu'ils venaient de commencer.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (err) {
      surEchec(err);
    } finally {
      setOccupe(false);
    }
  }

  const nomAffiche = message.mediaNom ?? (nature === 'video' ? t('Vidéo', 'Video') : nature === 'image' ? t('Photo', 'Photo') : t('Document', 'Document'));

  return (
    <div className="space-y-1" data-testid={`piece-jointe-${message.id}`}>
      {expire ? (
        <p className="text-xs italic opacity-80" data-testid={`piece-jointe-expiree-${message.id}`}>
          {nature === 'image' ? '🖼️' : '📎'} {nomAffiche} · {direExpire}
        </p>
      ) : nature === 'image' && !imageRefusee ? (
        image ? (
          <button
            type="button"
            onClick={() => setAgrandie((v) => !v)}
            title={agrandie ? t('Réduire', 'Shrink') : t('Agrandir', 'Enlarge')}
            className="block"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={image}
              alt={legende ?? t('Photo reçue', 'Received photo')}
              data-testid={`piece-jointe-image-${message.id}`}
              className={`rounded-lg object-contain ${agrandie ? 'max-h-[70vh] max-w-full' : 'max-h-56 max-w-[240px]'}`}
            />
          </button>
        ) : erreur === null ? (
          <p className="text-xs opacity-70">{t('Chargement de la photo…', 'Loading photo…')}</p>
        ) : null
      ) : (
        <button
          type="button"
          onClick={() => { void telecharger(); }}
          disabled={occupe}
          data-testid={`piece-jointe-telecharger-${message.id}`}
          className="flex max-w-full items-center gap-1.5 rounded-lg bg-white/70 px-2 py-1 text-left text-xs font-medium text-ink-700 hover:bg-white disabled:opacity-50"
        >
          <span aria-hidden="true">{nature === 'video' ? '🎬' : '📎'}</span>
          <span className="truncate">{nomAffiche}</span>
          <span className="shrink-0 text-ink-500">{occupe ? t('Téléchargement…', 'Downloading…') : t('Télécharger', 'Download')}</span>
        </button>
      )}
      {legende !== null && <p className="whitespace-pre-wrap">{legende}</p>}
      {erreur && <p className="text-xs text-red-600" data-testid={`piece-jointe-erreur-${message.id}`}>{erreur}</p>}
    </div>
  );
}
