'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getContactHistory, type ContactHistory, type ContactSend, type ContactConversation } from '@/lib/api';
import { useT, useLocale } from '@/lib/i18n';
import { formatDate, hourMin } from '@/lib/day';

/**
 * Onglet « Historique » de la fiche contact : ce qu'on lui a envoyé, et ce qu'il nous a répondu.
 *
 * Chargé PARESSEUSEMENT, au premier affichage de l'onglet : la fiche s'ouvre souvent juste pour corriger un
 * champ, et deux requêtes de plus à chaque ouverture ne se justifieraient pas.
 *
 * Les messages ne sont volontairement PAS embarqués : on affiche les métadonnées d'une conversation et un lien
 * vers l'inbox. Les charger ici ferait une requête par conversation (N+1) pour une réponse énorme, alors que
 * l'inbox sait déjà afficher un fil.
 */
export function ContactHistoryPanel({ tenantId, contactId }: { tenantId: string; contactId: string }) {
  const t = useT();
  const { locale } = useLocale();
  const [history, setHistory] = useState<ContactHistory | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getContactHistory(tenantId, contactId)
      .then((h) => { if (alive) setHistory(h); })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : t('Historique indisponible', 'History unavailable'));
      });
    return () => { alive = false; };
  }, [tenantId, contactId, t]);

  const stamp = (iso: string) => `${formatDate(iso, locale, { day: '2-digit', month: '2-digit', year: '2-digit' })} ${hourMin(iso, locale)}`;

  if (error) return <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>;
  if (!history) return <p className="mt-4 text-sm text-ink-500">{t('Chargement...', 'Loading...')}</p>;

  return (
    <div className="mt-4 space-y-6">
      <section>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
          {t('Campagnes reçues', 'Campaigns received')} ({history.sends.length})
        </h4>
        {history.sends.length === 0 ? (
          <p className="text-sm text-ink-500">{t('Aucun envoi à ce contact.', 'No sends to this contact.')}</p>
        ) : (
          <ul className="space-y-2">
            {history.sends.map((s, i) => <SendRow key={`${s.campaignId}-${i}`} send={s} stamp={stamp} />)}
          </ul>
        )}
      </section>

      <section>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
          {t('Conversations', 'Conversations')} ({history.conversations.length})
        </h4>
        {history.conversations.length === 0 ? (
          <p className="text-sm text-ink-500">{t('Aucune conversation avec ce contact.', 'No conversation with this contact.')}</p>
        ) : (
          <ul className="space-y-2">
            {history.conversations.map((c) => <ConversationRow key={c.conversationId} conv={c} stamp={stamp} />)}
          </ul>
        )}
      </section>
    </div>
  );
}

function SendRow({ send, stamp }: { send: ContactSend; stamp: (iso: string) => string }) {
  const t = useT();
  // Ce que le template ou le scénario a envoyé. Une campagne porte l'un ou l'autre, jamais les deux.
  const what = send.templateName
    ? `${send.templateName}${send.templateLanguage ? ` (${send.templateLanguage})` : ''}`
    : send.workflowName ?? t('scénario supprimé', 'deleted scenario');

  return (
    <li className="rounded-xl border border-ink-200 bg-white px-3 py-2.5 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium text-ink-900">{send.campaignName}</p>
          <p className="truncate text-xs text-ink-500">
            {what} · {send.category}
          </p>
        </div>
        <span className="shrink-0 text-xs text-ink-400">{send.sentAt ? stamp(send.sentAt) : t('non envoyé', 'not sent')}</span>
      </div>
      <p className="mt-1 text-xs">
        <DeliveryBadge send={send} stamp={stamp} />
      </p>
      {send.error && <p className="mt-1 text-xs text-red-600">{send.error}</p>}
    </li>
  );
}

/**
 * Statut d'un envoi. DEUX colonnes distinctes se lisent ici, et les confondre produit des affirmations fausses :
 *
 *  - `status` est le sort de l'APPEL à Meta : pending, sending, sent, failed, skipped ;
 *  - `deliveryStatus` est le cycle de vie du message APRÈS un envoi réussi (sent < delivered < read, ou failed).
 *    Il reste donc NULL sur un envoi qui a échoué : il n'y a jamais eu de message à suivre.
 *
 * Le `status` est traité EN PREMIER et EN ENTIER. Sans ça, un envoi en échec (numéro invalide, refus Meta)
 * tombait dans le repli et s'affichait « envoyé, statut inconnu », en contradiction avec le « non envoyé » de
 * la même carte. On n'atteint le `deliveryStatus` qu'une fois le message réellement parti.
 *
 * Sur un envoi parti, `deliveryStatus` NULL veut dire « Meta ne nous a jamais renvoyé de statut », PAS
 * « non délivré » : on ne peut ni accuser à tort, ni prétendre à une livraison qu'on n'a pas constatée. Et il
 * n'existe aucun horodatage par étape en base, donc pas de « délivré à 14h02, lu à 14h07 ».
 */
function DeliveryBadge({ send, stamp }: { send: ContactSend; stamp: (iso: string) => string }) {
  const t = useT();
  if (send.status === 'skipped') {
    return <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-700">{t('écarté', 'skipped')}</span>;
  }
  if (send.status === 'pending' || send.status === 'sending') {
    return <span className="rounded-full bg-ink-100 px-2 py-0.5 text-ink-600">{t('en attente', 'pending')}</span>;
  }
  if (send.status === 'failed') {
    // Échec de l'ENVOI. Le motif exact est affiché juste en dessous par `SendRow` (`send.error`).
    return <span className="rounded-full bg-red-50 px-2 py-0.5 text-red-700">{t('envoi en échec', 'send failed')}</span>;
  }
  // À partir d'ici le message est bien parti : il ne reste qu'à qualifier son suivi de livraison.
  const LABEL: Record<string, [string, string, string]> = {
    sent: [t('envoyé', 'sent'), 'bg-ink-100', 'text-ink-600'],
    delivered: [t('délivré', 'delivered'), 'bg-blue-50', 'text-blue-700'],
    read: [t('lu', 'read'), 'bg-green-50', 'text-green-700'],
    failed: [t('non délivré', 'not delivered'), 'bg-red-50', 'text-red-700'],
  };
  const d = send.deliveryStatus ? LABEL[send.deliveryStatus] : undefined;
  if (!d) {
    return (
      <span className="rounded-full bg-ink-100 px-2 py-0.5 text-ink-500" title={t('Meta ne nous a pas renvoyé de statut de livraison pour ce message.', 'Meta did not report a delivery status for this message.')}>
        {t('envoyé, statut inconnu', 'sent, status unknown')}
      </span>
    );
  }
  // `deliveryUpdatedAt` est l'instant du DERNIER changement d'état, pas celui de l'étape affichée : en infobulle
  // plutôt qu'en clair, pour ne pas laisser lire « lu à telle heure » là où on ne sait que « dernier signal reçu ».
  return (
    <span
      className={`rounded-full px-2 py-0.5 ${d[1]} ${d[2]}`}
      {...(send.deliveryUpdatedAt ? { title: `${t('dernier signal reçu', 'last signal received')} : ${stamp(send.deliveryUpdatedAt)}` } : {})}
    >
      {d[0]}
    </span>
  );
}

function ConversationRow({ conv, stamp }: { conv: ContactConversation; stamp: (iso: string) => string }) {
  const t = useT();
  return (
    <li className="rounded-xl border border-ink-200 bg-white px-3 py-2.5 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-ink-900">{conv.lastPreview ?? <span className="text-ink-400">{t('(sans aperçu)', '(no preview)')}</span>}</p>
          <p className="text-xs text-ink-500">
            {conv.messagesCount} {t('message(s)', 'message(s)')} · <span className="font-mono">{conv.waId}</span>
          </p>
        </div>
        <span className="shrink-0 text-xs text-ink-400">{stamp(conv.lastMessageAt)}</span>
      </div>

      {conv.analysis ? (
        <div className="mt-1.5 text-xs text-ink-600">
          <span className="text-ink-800">{conv.analysis.sentiment}</span> · {conv.analysis.topic || conv.analysis.intent} ·{' '}
          {conv.analysis.resolved ? t('résolu', 'resolved') : t('non résolu', 'unresolved')} ·{' '}
          {t('traité par', 'handled by')} {conv.analysis.handledBy}
          {/* Une analyse existe mais un message est arrivé depuis : la montrer sans le dire ferait passer une
              lecture périmée pour un état courant. */}
          {conv.analysisStale && (
            <span className="ml-1.5 rounded bg-amber-50 px-1.5 py-0.5 text-amber-700">
              {t('analyse à rafraîchir', 'analysis outdated')}
            </span>
          )}
        </div>
      ) : (
        <p className="mt-1.5 text-xs text-ink-400">
          {conv.analysisStatus === 'failed' ? t('analyse en échec', 'analysis failed') : t('pas encore analysée', 'not analyzed yet')}
        </p>
      )}

      <Link href={conv.inboxHref} className="mt-1.5 inline-block text-xs text-brand-600 hover:underline">
        {t('Ouvrir dans l\'inbox', 'Open in inbox')}
      </Link>
    </li>
  );
}
