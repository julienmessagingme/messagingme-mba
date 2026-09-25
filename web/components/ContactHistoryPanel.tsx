'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getContactHistory, getContactBilan, getContactSendsForExport, type ContactHistory, type BilanContact, type ContactSend, type ContactConversation } from '@/lib/api';
import { useT, useLocale } from '@/lib/i18n';
import { formatDate, hourMin } from '@/lib/day';
import { explainMetaError } from '@/lib/meta-errors';
import { phraseResumeAbsent } from '@/lib/resume-conversation';
import { toCsv, downloadCsv } from '@/lib/csv';
import { Bouton } from '@/components/Bouton';
import { Squelette } from '@/components/Squelette';
import { Nd } from '@/components/Nd';

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
  /**
   * Le bilan est CHARGÉ À PART, et son échec est SILENCIEUX (il reste `null`).
   *
   * ⚠️ Il va chercher les tarifs chez Meta : il est plus lent que l'historique et il peut tomber tout seul
   * (jeton, panne, instance sans Meta). Le faire partager l'état d'erreur de l'historique ferait disparaître
   * la liste des envois pour une carte d'en-tête, ce qui échangerait l'essentiel contre l'accessoire.
   */
  const [bilan, setBilan] = useState<BilanContact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // Export CSV de l'historique des envois (F5), NON capé (getContactSendsForExport). Le CSV est construit et téléchargé
  // côté client (le serveur renvoie du JSON). Colonnes : campagne, statut, livraison, type, template/scénario, envoyé
  // le, type d'erreur (texte Meta brut), explication (traduite via explainMetaError).
  async function exportCsv() {
    setExporting(true);
    setError(null);
    try {
      const { sends } = await getContactSendsForExport(tenantId, contactId);
      const headers = [
        t('Campagne', 'Campaign'), t('Statut', 'Status'), t('Livraison', 'Delivery'), t('Type', 'Type'),
        t('Template / Scénario', 'Template / Scenario'), t('Envoyé le', 'Sent at'),
        t("Type d’erreur", 'Error type'), t("Explication de l’erreur", 'Error explanation'),
      ];
      const rows = sends.map((s) => [
        s.campaignName, s.status, s.deliveryStatus ?? '', s.category,
        s.templateName ? `${s.templateName}${s.templateLanguage ? ` (${s.templateLanguage})` : ''}` : (s.workflowName ?? ''),
        s.sentAt ?? '', s.error ?? '', explainMetaError(s.error, locale) ?? '',
      ]);
      downloadCsv(t(`historique-${contactId}.csv`, `history-${contactId}.csv`), toCsv(headers, rows));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Export impossible', 'Export failed'));
    } finally {
      setExporting(false);
    }
  }

  useEffect(() => {
    let alive = true;
    getContactHistory(tenantId, contactId)
      .then((h) => { if (alive) setHistory(h); })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : t('Historique indisponible', 'History unavailable'));
      });
    // En PARALLÈLE, jamais en chaîne : l'historique est local, le bilan passe par Meta.
    getContactBilan(tenantId, contactId)
      .then((b) => { if (alive) setBilan(b); })
      .catch(() => { if (alive) setBilan(null); });
    return () => { alive = false; };
  }, [tenantId, contactId, t]);

  const stamp = (iso: string) => `${formatDate(iso, locale, { day: '2-digit', month: '2-digit', year: '2-digit' })} ${hourMin(iso, locale)}`;

  if (error) return <p className="mt-4 rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</p>;
  if (!history) return <Squelette forme="lignes" className="mt-4" />;

  return (
    <div className="mt-4 space-y-6">
      {bilan && <Bilan bilan={bilan} />}
      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h4 className="text-xs font-medium text-ink-500">
            {t('Campagnes reçues', 'Campaigns received')} ({history.sends.length})
          </h4>
          {history.sends.length > 0 && (
            <Bouton variante="secondaire" taille="petite" enCours={exporting}
              type="button"
              onClick={() => void exportCsv()}
              disabled={exporting}
              data-testid="contact-history-export"
              className="shrink-0"
            >
              {exporting ? t('Export…', 'Exporting…') : t('Exporter en CSV', 'Export to CSV')}
            </Bouton>
          )}
        </div>
        {history.sends.length === 0 ? (
          <p className="text-sm text-ink-500">{t('Aucun envoi à ce contact.', 'No sends to this contact.')}</p>
        ) : (
          <ul className="space-y-2">
            {history.sends.map((s, i) => <SendRow key={`${s.campaignId}-${i}`} send={s} stamp={stamp} />)}
          </ul>
        )}
      </section>

      <section>
        <h4 className="mb-2 text-xs font-medium text-ink-500">
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
    <li className="rounded-carte border border-ink-200 bg-white px-3 py-2.5 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium text-ink-900">{send.campaignName}</p>
          <p className="truncate text-xs text-ink-500">
            {what} · {send.category}
          </p>
        </div>
        <span className="shrink-0 text-xs text-ink-500">{send.sentAt ? stamp(send.sentAt) : t('non envoyé', 'not sent')}</span>
      </div>
      <p className="mt-1 flex flex-wrap items-center gap-1 text-xs">
        <DeliveryBadge send={send} stamp={stamp} />
        {/* 🔴 « Engagé » est À CÔTÉ de « lu », pas à la place, parce que ce sont deux informations
            différentes : « lu » dit que Meta a affiché le message, « engagé » dit qu'un humain a fait quelque
            chose. Un message peut être lu par milliers sans qu'une seule personne ne réagisse, et c'est
            précisément l'écart que ce second badge rend visible.
            Il n'apparaît que quand c'est VRAI : un badge « pas engagé » sur chaque ligne noierait la seule
            information qui compte, celle des lignes où quelqu'un a réagi. */}
        {send.engage && (
          <span
            data-testid="envoi-engage"
            className="rounded-full bg-brand-100 px-2 py-0.5 font-medium text-brand-700"
            title={t(
              'Le contact a répondu ou appuyé sur un bouton après cet envoi, dans les 24 h et avant l’envoi suivant.',
              'The contact replied or pressed a button after this send, within 24h and before the next send.',
            )}
          >
            {t('engagé', 'engaged')}
          </span>
        )}
      </p>
      {send.error && <p className="mt-1 text-xs text-danger-600">{send.error}</p>}
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
    return <span className="rounded-full bg-alerte-50 px-2 py-0.5 text-alerte-700">{t('écarté', 'skipped')}</span>;
  }
  if (send.status === 'pending' || send.status === 'sending') {
    return <span className="rounded-full bg-ink-100 px-2 py-0.5 text-ink-500">{t('en attente', 'pending')}</span>;
  }
  if (send.status === 'failed') {
    // Échec de l'ENVOI. Le motif exact est affiché juste en dessous par `SendRow` (`send.error`).
    return <span className="rounded-full bg-danger-50 px-2 py-0.5 text-danger-700">{t('envoi en échec', 'send failed')}</span>;
  }
  // À partir d'ici le message est bien parti : il ne reste qu'à qualifier son suivi de livraison.
  const LABEL: Record<string, [string, string, string]> = {
    sent: [t('envoyé', 'sent'), 'bg-ink-100', 'text-ink-500'],
    delivered: [t('délivré', 'delivered'), 'bg-brand-50', 'text-brand-700'],
    read: [t('lu', 'read'), 'bg-succes-50', 'text-succes-700'],
    failed: [t('non délivré', 'not delivered'), 'bg-danger-50', 'text-danger-700'],
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
    <li className="rounded-carte border border-ink-200 bg-white px-3 py-2.5 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-ink-900">{conv.lastPreview ?? <span className="text-ink-500">{t('(sans aperçu)', '(no preview)')}</span>}</p>
          <p className="text-xs text-ink-500">
            {conv.messagesCount} {t('message(s)', 'message(s)')} · <span className="font-mono">{conv.waId}</span>
          </p>
        </div>
        <span className="shrink-0 text-xs text-ink-500">{stamp(conv.lastMessageAt)}</span>
      </div>

      {conv.analysis ? (
        <div className="mt-1.5 text-xs text-ink-500">
          <span className="text-ink-900">{conv.analysis.sentiment}</span> · {conv.analysis.topic || conv.analysis.intent} ·{' '}
          {conv.analysis.resolved ? t('résolu', 'resolved') : t('non résolu', 'unresolved')} ·{' '}
          {t('traité par', 'handled by')} {conv.analysis.handledBy}
          {/* Une analyse existe mais un message est arrivé depuis : la montrer sans le dire ferait passer une
              lecture périmée pour un état courant. */}
          {conv.analysisStale && (
            <span className="ml-1.5 rounded-controle bg-alerte-50 px-1.5 py-0.5 text-alerte-700">
              {t('analyse à rafraîchir', 'analysis outdated')}
            </span>
          )}
          {/* CE QUI S'EST DIT, conversation par conversation. La fiche n'en montre qu'UN (celui de la
              dernière conversation analysée) : ici il y a la place de les montrer tous, et c'est ce qui
              rend l'onglet utile quand un contact a plusieurs fils. La phrase du cas « analysé avant que le
              résumé existe » vient du module partagé, pour ne pas en écrire une troisième version.

              🔴 `undefined` ET `null` NE VEULENT PAS DIRE LA MÊME CHOSE ICI, et les confondre afficherait un
              mensonge pendant chaque déploiement. `null` = cette analyse-là n'a pas de résumé, c'est définitif
              et l'écran le dit ; `undefined` = c'est l'API qui ne rend pas encore le champ, et le front part
              AVANT elle (Vercel suit `main`, le VPS se déploie à la main). Pendant cette fenêtre, on n'affiche
              rien plutôt que d'accuser chaque analyse d'être antérieure à la migration 0100. */}
          {conv.analysis.summary !== undefined && (
            <p className={conv.analysis.summary ? 'mt-1 whitespace-pre-line text-ink-900' : 'mt-1 italic text-ink-500'}>
              {conv.analysis.summary ?? phraseResumeAbsent('sans-resume', t)}
            </p>
          )}
        </div>
      ) : (
        <p className="mt-1.5 text-xs text-ink-500">
          {conv.analysisStatus === 'failed' ? t('analyse en échec', 'analysis failed') : t('pas encore analysée', 'not analyzed yet')}
        </p>
      )}

      <Link href={conv.inboxHref} className="mt-1.5 inline-block text-xs text-brand-600 hover:underline">
        {t('Ouvrir dans l’inbox', 'Open in inbox')}
      </Link>
    </li>
  );
}

/**
 * CE QUE LE CONTACT A COÛTÉ, ET JUSQU'OÙ IL EST ALLÉ. Demande de Julien, le 2026-09-11 : « tout en haut,
 * mettre le fric que la personne nous a coûté et EN FACE le nombre d'engagements de 1er niveau [...] puis de
 * 2e niveau, 3e niveau ». D'où les deux moitiés côte à côte : la dépense et ce qu'elle a produit.
 *
 * 🔴 UN COÛT INCONNU N'EST PAS UN COÛT NUL, et l'écran ne les confond pas. « — » quand aucun envoi n'a pu
 * être chiffré, jamais « 0 € », qui se lirait « ce contact ne nous a rien coûté ». Et le nombre d'envois non
 * chiffrables est DIT, avec sa cause, parce qu'un total amputé en silence se lit comme un total.
 *
 * ⚠️ C'EST UN PLANCHER, PAS UNE FACTURE, et le mot « estimé » est là pour ça : seuls les envois de CAMPAGNE
 * sont comptés. Un message de scénario ou une réponse d'opérateur dans la fenêtre de service ne passe pas
 * par la même table ; Meta les facture souvent à zéro, mais pas toujours.
 */
function Bilan({ bilan }: { bilan: BilanContact }) {
  const t = useT();
  const { locale } = useLocale();
  const { cout, entonnoir } = bilan;
  const montant = cout.cout === null
    ? <Nd />
    : new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'fr-FR', cout.currency
      ? { style: 'currency', currency: cout.currency }
      : { maximumFractionDigits: 2 }).format(cout.cout);
  const max = entonnoir.length > 0 ? entonnoir[0]!.parcours : 0;

  return (
    <section data-testid="contact-bilan" className="grid gap-4 rounded-carte border border-ink-200 bg-ink-50/60 p-4 sm:grid-cols-[minmax(0,14rem)_1fr]">
      <div>
        <p className="text-xs font-medium text-ink-500">{t('Ce qu’il a coûté', 'What they cost')}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums text-ink-900" data-testid="contact-bilan-cout">{montant}</p>
        <p className="mt-0.5 text-xs text-ink-500">
          {t(`${cout.envoyes} envoi${cout.envoyes > 1 ? 's' : ''} de campagne, coût estimé`,
            `${cout.envoyes} campaign send${cout.envoyes > 1 ? 's' : ''}, estimated cost`)}
        </p>
        {/* La troncature se DIT, et sa cause avec : une catégorie absente est un héritage définitif, un
            tarif manquant est une panne du jour. Les deux se réparent différemment. */}
        {cout.nonChiffrables > 0 && (
          <p className="mt-1 text-xs text-alerte-800" data-testid="contact-bilan-nonchiffrables">
            {t(`${cout.nonChiffrables} non chiffré${cout.nonChiffrables > 1 ? 's' : ''}`,
              `${cout.nonChiffrables} not priced`)}
            {cout.sansCategorie > 0 && t(` (${cout.sansCategorie} sans catégorie enregistrée)`, ` (${cout.sansCategorie} with no recorded category)`)}
            {cout.sansTarif > 0 && t(` (${cout.sansTarif} sans tarif rendu par Meta)`, ` (${cout.sansTarif} with no rate from Meta)`)}
          </p>
        )}
      </div>

      <div>
        <p className="text-xs font-medium text-ink-500">{t('Jusqu’où il est allé', 'How far they went')}</p>
        {entonnoir.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500" data-testid="contact-bilan-sans-engagement">
            {t('Il n’a réagi à aucun message.', 'They reacted to no message.')}
          </p>
        ) : (
          <div className="mt-2 flex flex-col gap-1">
            {entonnoir.map((n) => (
              <div key={n.niveau} className="flex items-center gap-2" data-testid={`contact-bilan-niveau-${n.niveau}`}>
                <span className="w-16 shrink-0 text-xs text-ink-500">
                  {t(`Niveau ${n.niveau}`, `Level ${n.niveau}`)}
                </span>
                {/* La barre est proportionnelle au PREMIER niveau, qui est le plus large par construction :
                    un entonnoir se lit à la décroissance, et une barre normalisée sur son propre maximum
                    montrerait cinq barres pleines. */}
                <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-ink-100">
                  <span
                    className="block h-full rounded-full bg-brand-400"
                    style={{ width: `${max > 0 ? Math.round((n.parcours / max) * 100) : 0}%` }}
                  />
                </span>
                <span className="w-6 shrink-0 text-right text-xs font-medium tabular-nums text-ink-900">{n.parcours}</span>
              </div>
            ))}
            <p className="mt-1 text-xs text-ink-500">
              {t('Un niveau de plus = il a encore réagi au message suivant, en répondant ou en cliquant.',
                'One more level = they reacted to the next message again, by replying or clicking.')}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
