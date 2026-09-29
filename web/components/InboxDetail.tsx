'use client';

import { useEffect, useState } from 'react';
import type { Session } from '@/lib/session';
import { useLocale, useT } from '@/lib/i18n';
import { dateHeure } from '@/lib/day';
import { lireDetailConversation } from '@/lib/api';
import {
  ecrireRepliDetail, libelleEvenement, lireRepliDetail, origineEvenement, type DetailConversation,
} from '@/lib/inbox-detail';
import { Icone } from '@/components/Icone';
import { Squelette } from '@/components/Squelette';

/**
 * LE PANNEAU DÉTAIL D'UNE CONVERSATION (cadrage du 2026-09-28) : la moitié basse de la colonne des conversations,
 * quand une conversation est choisie. Qui est la personne, où en est la conversation, ce qui lui est arrivé.
 *
 * 🔴 LECTURE SEULE : les gestes restent dans l'en-tête du fil. Deux endroits pour le même geste finissent par
 * diverger, et le dépôt l'a payé sur le contrôle du fil.
 *
 * ⚠️ UNE ROUTE ABSENTE REPLIE LE PANNEAU SANS ERREUR : la console part sur Vercel au push, avant l'API qui porte
 * la route. Tant que le détail n'est pas lisible (404, réponse mal formée, conversation qu'un agent ne voit pas),
 * le panneau ne prend AUCUNE place et la liste garde toute la hauteur.
 *
 * ⚠️ Il se relit quand la conversation change et quand `rafraichir` change (un geste de l'en-tête : assigner,
 * prendre, ranger). En changeant de conversation, il garde sa place (squelette) s'il était déjà affiché, pour que
 * la liste ne saute pas à chaque clic ; il n'affiche jamais le détail d'une conversation pour une autre.
 */
export function InboxDetail({ session, conversationId, rafraichir, onOuvrirFiche }: {
  session: Session;
  conversationId: string;
  /** Change après un geste de l'en-tête du fil : le panneau relit le détail. */
  rafraichir: number;
  /** Ouvre la fiche du contact dans la colonne de droite (la même que le clic sur le nom dans la liste). */
  onOuvrirFiche: () => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  /**
   * Replié ou non, retenu par navigateur. Lu APRÈS le montage : pendant le premier rendu, `window` n'est pas
   * forcément là, et un état lu au rendu divergerait entre serveur et navigateur.
   */
  const [replie, setReplie] = useState(false);
  useEffect(() => { setReplie(lireRepliDetail()); }, []);
  const [detail, setDetail] = useState<DetailConversation | null>(null);
  /** A-t-on déjà montré un détail ? Décide si le panneau garde sa place pendant qu'il en charge un autre. */
  const [dejaMontre, setDejaMontre] = useState(false);
  const [chargement, setChargement] = useState(true);

  useEffect(() => {
    if (replie) return;
    let vivant = true;
    setChargement(true);
    // Le détail d'une AUTRE conversation ne reste jamais affiché : on l'efface avant de relire.
    setDetail((d) => (d && d.conversationId === conversationId ? d : null));
    void lireDetailConversation(session.tenantId, conversationId).then((d) => {
      if (!vivant) return;
      setDetail(d);
      setChargement(false);
      if (d) setDejaMontre(true);
      else setDejaMontre(false);
    });
    return () => { vivant = false; };
  }, [session.tenantId, conversationId, rafraichir, replie]);

  function basculer(): void {
    const suivant = !replie;
    setReplie(suivant);
    ecrireRepliDetail(suivant);
  }

  if (replie) {
    return (
      <div data-testid="inbox-detail" data-replie="oui" className="mt-2 shrink-0">
        <button
          type="button"
          onClick={basculer}
          aria-expanded={false}
          data-testid="inbox-detail-basculer"
          className="flex w-full items-center justify-between rounded-carte border border-ink-200 bg-white px-3 py-2 text-xs font-medium text-ink-700 hover:bg-ink-50"
        >
          {t('Détail de la conversation', 'Conversation details')}
          <Icone nom="deplier" taille="petite" className="rotate-180" />
        </button>
      </div>
    );
  }

  const aMontrer = detail !== null && detail.conversationId === conversationId;
  // Rien de lisible : aucune place prise, sauf pendant le chargement qui suit un détail déjà montré.
  if (!aMontrer && !(chargement && dejaMontre)) return null;

  return (
    <section
      data-testid="inbox-detail"
      aria-label={t('Détail de la conversation', 'Conversation details')}
      className="mt-2 flex flex-col rounded-carte border border-ink-200 bg-white lg:min-h-0 lg:flex-1"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-ink-100 px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-500">{t('Détail', 'Details')}</h2>
        <button
          type="button"
          onClick={basculer}
          aria-expanded
          aria-label={t('Replier le détail', 'Collapse details')}
          data-testid="inbox-detail-basculer"
          className="rounded-controle p-1 text-ink-500 hover:bg-ink-50 hover:text-ink-700"
        >
          <Icone nom="deplier" taille="petite" />
        </button>
      </div>
      {/* `lg:min-h-0 lg:flex-1` : sans eux, le corps garde la hauteur de son contenu et déborde du panneau au lieu
          de défiler seul, dès que la frise est longue. */}
      <div data-testid="inbox-detail-corps" className="min-w-0 space-y-3 px-3 py-2.5 text-sm lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        {!aMontrer ? <Squelette forme="carte" /> : <Contenu detail={detail} onOuvrirFiche={onOuvrirFiche} t={t} locale={locale} />}
      </div>
    </section>
  );
}

function Contenu({ detail, onOuvrirFiche, t, locale }: {
  detail: DetailConversation;
  onOuvrirFiche: () => void;
  t: (fr: string, en?: string) => string;
  locale: 'fr' | 'en';
}) {
  const i = detail.identite;
  const nomComplet = [i.prenom, i.nom].filter((x): x is string => typeof x === 'string' && x.trim() !== '').join(' ');
  return (
    <>
      <div data-testid="inbox-detail-identite" className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="min-w-0 break-words font-semibold text-ink-900">{nomComplet || `+${i.waId}`}</span>
          {i.desabonne && (
            <span data-testid="inbox-detail-desabonne" className="rounded-full bg-alerte-100 px-1.5 py-px text-xs font-medium text-alerte-800">
              {t('désabonné', 'unsubscribed')}
            </span>
          )}
          {i.bloque && (
            <span data-testid="inbox-detail-bloque" className="rounded-full bg-danger-100 px-1.5 py-px text-xs font-medium text-danger-700">
              {t('bloqué', 'blocked')}
            </span>
          )}
        </div>
        <p className="break-words text-xs text-ink-500">
          {i.telephone ?? `+${i.waId}`}
          {i.email ? <span className="block">{i.email}</span> : null}
        </p>
        {i.tags.length > 0 && (
          <ul className="flex flex-wrap gap-1" aria-label={t('Tags', 'Tags')}>
            {i.tags.map((tag) => (
              <li key={tag} className="rounded-full bg-ink-100 px-1.5 py-px text-xs text-ink-700">{tag}</li>
            ))}
          </ul>
        )}
        {i.contactId !== null && (
          <button
            type="button"
            onClick={onOuvrirFiche}
            data-testid="inbox-detail-fiche"
            className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"
          >
            <Icone nom="contact" taille="petite" />
            {t('Ouvrir la fiche', 'Open the record')}
          </button>
        )}
      </div>

      <div>
        <h3 className="text-xs font-semibold text-ink-500">{t('Résumé', 'Summary')}</h3>
        <p data-testid="inbox-detail-resume" className={`break-words text-sm ${detail.resume ? 'text-ink-800' : 'italic text-ink-500'}`}>
          {detail.resume ?? t('Pas encore analysée.', 'Not analysed yet.')}
        </p>
      </div>

      <p data-testid="inbox-detail-assignation" className="text-xs text-ink-700">
        {detail.assignation
          ? t(`Assignée à ${detail.assignation.nom}`, `Assigned to ${detail.assignation.nom}`)
          : t('Non affectée', 'Unassigned')}
      </p>

      <div>
        <h3 className="text-xs font-semibold text-ink-500">{t('Historique', 'History')}</h3>
        {detail.historique.length === 0 ? (
          <p className="text-xs text-ink-500">{t('Rien pour l’instant.', 'Nothing yet.')}</p>
        ) : (
          <ol data-testid="inbox-detail-frise" className="mt-1 space-y-1.5 border-l border-ink-200 pl-3">
            {detail.historique.map((e) => {
              const origine = origineEvenement(e, t);
              return (
                <li key={e.id} data-testid="inbox-detail-evenement" data-type={e.type} className="min-w-0">
                  <p className="break-words text-xs text-ink-800">{libelleEvenement(e, t)}</p>
                  <p className="break-words text-xs text-ink-500">
                    {dateHeure(e.at, locale)}
                    {origine ? ` · ${origine}` : ''}
                  </p>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </>
  );
}
