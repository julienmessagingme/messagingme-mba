'use client';

import { CadreDoc } from '@/components/doc-api/CadreDoc';
import {
  Bloc, Champs, Code, Encadre, EnTetePage, Erreurs, LienDoc, Liste, Route, Section, Sous, SurCettePage, Tableau, curl, json,
} from '@/components/doc-api/elements';
import { useT } from '@/lib/i18n';
import { BORNES, EXEMPLES_CORPS, EXEMPLES_REPONSES } from '@/lib/api-exemples';
import { CHAMPS } from '@/lib/api-champs';

/**
 * LES MESSAGES SIMPLES : un texte, une fiche existante, tout de suite, en WhatsApp ou en RCS. Les envois (une cible
 * vers une liste) ont leur page, `sends` ; le tableau d'en-tête dit lequel choisir. Chaque route suit le patron de
 * `Route`, et ses champs viennent de `@/lib/api-champs`.
 */
export default function ApiMessagesPage() {
  return <CadreDoc page="messages">{() => <Messages />}</CadreDoc>;
}

function Messages() {
  const t = useT();
  const requete = t('Requête', 'Request');
  const reponse = t('Réponse 200', '200 response');
  const erreurs = t('Erreurs', 'Errors');
  const notes = t('Notes', 'Notes');
  const ordre = t('Dans l’ordre où elles sont vérifiées :', 'In the order they are checked:');

  return (
    <>
      <EnTetePage page="messages">
        <p>
          {t('Un texte, à une fiche existante, envoyé tout de suite. Pour une liste de destinataires, un template ou un scénario :', 'One text, to an existing record, sent right away. For a list of recipients, a template or a scenario:')}{' '}
          <LienDoc page="sends">{t('Envois', 'Sends')}</LienDoc>.
        </p>
      </EnTetePage>
      <SurCettePage page="messages" />

      <Section id="messages-simples" titre={t('Message ou envoi', 'Message or send')}>
        <Tableau
          entetes={['', t('Message', 'Message'), t('Envoi', 'Send')]}
          lignes={[
            { cle: 'qui', cellules: [t('Destinataires', 'Recipients'), t('Une fiche', 'One record'), t(`1 à ${BORNES.destinatairesParEnvoi}`, `1 to ${BORNES.destinatairesParEnvoi}`)] },
            { cle: 'quoi', cellules: [t('Contenu', 'Content'), t('Un texte', 'One text'), t('Template, scénario, bloc ou message RCS', 'Template, scenario, block or RCS message')] },
            { cle: 'quand', cellules: [t('Traitement', 'Processing'), t('Synchrone : la réponse 200 porte le message', 'Synchronous: the 200 response carries the message'), t('Asynchrone : GET /v1/sends/{sendId}', 'Asynchronous: GET /v1/sends/{sendId}')] },
            { cle: 'fiche', cellules: [t('Fiche inconnue', 'Unknown record'), t('Refusée', 'Refused'), t('Créée avec un phone, sauf ouverture whatsapp_session', 'Created with a phone, except with a whatsapp_session opening')] },
            { cle: 'rejeu', cellules: [t('Idempotence', 'Idempotency'), t('Non', 'No'), <LienDoc key="i" page="concepts" ancre="idempotence">{t('Oui, clé obligatoire', 'Yes, key required')}</LienDoc>] },
          ]}
        />
        <Liste>
          <li>{t('Le message apparaît dans l’Inbox.', 'The message shows in the Inbox.')}</li>
          <li>{t('Il prend le fil : le scénario en cours s’arrête, l’agent de Meta cesse de répondre.', 'It takes the thread: the running scenario stops, the Meta agent stops replying.')}</li>
        </Liste>
        <Encadre sorte="attention">
          <p>{t('Pas de clé d’idempotence : rejouer l’appel envoie un second message.', 'No idempotency key: replaying the call sends a second message.')}</p>
        </Encadre>
      </Section>

      <Route ep="POST /v1/messages/whatsapp">
        <Sous>{requete}</Sous>
        <Champs table={CHAMPS.messageWhatsapp} />
        <Bloc legende={t('Commande', 'Command')}>{curl('/v1/messages/whatsapp', EXEMPLES_CORPS.messageWhatsapp.corps)}</Bloc>
        <Sous>{reponse}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.messageEnvoye)}</Bloc>
        <p>{t('conversationId est toujours renseigné.', 'conversationId is always set.')}</p>
        <Sous>{erreurs}</Sous>
        <p>{ordre}</p>
        <Erreurs
          clesDeFiche
          lignes={[
            ['unknown_contact', t('Fiche inconnue.', 'Unknown record.')],
            ['blocked_contact', t('Fiche bloquée, ou sans adresse WhatsApp.', 'Record blocked, or without a WhatsApp address.')],
            ['window_closed', t('Fenêtre de 24 h fermée.', '24-hour window closed.')],
            ['opted_out', t('Fiche désabonnée.', 'Record opted out.')],
            ['no_whatsapp_number', t('Espace sans numéro WhatsApp.', 'Workspace without a WhatsApp number.')],
            ['number_unlinked', t('Numéro délié depuis l’Accueil.', 'Number unlinked from the Home page.')],
          ]}
        />
        <Sous>{notes}</Sous>
        <p>
          {t('Fenêtre fermée : seul un template peut partir.', 'Window closed: only a template can go out.')}{' '}
          <LienDoc page="concepts" ancre="fenetre-24h">{t('La fenêtre de 24 h', 'The 24-hour window')}</LienDoc>
        </p>
      </Route>

      <Route ep="POST /v1/messages/rcs">
        <Sous>{requete}</Sous>
        <Champs table={CHAMPS.messageRcs} />
        <Bloc legende={t('Commande', 'Command')}>{curl('/v1/messages/rcs', EXEMPLES_CORPS.messageRcs.corps)}</Bloc>
        <Sous>{reponse}</Sous>
        <p>
          {t(
            'Celle de POST /v1/messages/whatsapp, channel à rcs. conversationId vaut null dans un cas : le message est parti, mais la fiche a été bloquée ou supprimée entre-temps.',
            'That of POST /v1/messages/whatsapp, with channel set to rcs. conversationId is null in one case: the message was sent, but the record was blocked or deleted in the meantime.',
          )}
        </p>
        <Sous>{erreurs}</Sous>
        <p>{ordre}</p>
        <Erreurs
          clesDeFiche
          lignes={[
            ['unknown_contact', t('Fiche inconnue.', 'Unknown record.')],
            ['no_phone', t('Fiche sans numéro.', 'Record without a phone number.')],
            ['blocked_contact', t('Fiche bloquée.', 'Record blocked.')],
            ['opted_out', t('Désabonnée, en général ou du RCS.', 'Opted out, in general or from RCS.')],
            ['no_consent', t('Ni opted_in, ni jamais écrit.', 'Neither opted_in, nor ever wrote.')],
            ['rcs_not_enabled', t('Canal RCS inactif sur l’espace.', 'RCS channel inactive on the workspace.')],
            ['rcs_unreachable', t('Numéro connu comme injoignable en RCS.', 'Number known as unreachable over RCS.')],
          ]}
        />
        <Sous>{notes}</Sous>
        <Liste>
          <li>{t('Pas de fenêtre de 24 h en RCS.', 'No 24-hour window over RCS.')}</li>
          <li>
            {t(
              'Joignabilité RCS apprise après coup : le premier message vers un numéro sans RCS est accepté, son échec est enregistré (Sécurité > Journal des erreurs), le suivant est refusé en',
              'RCS reachability is learned afterwards: the first message to a number without RCS is accepted, its failure is recorded (Security > Error log), the next one is refused with',
            )}{' '}
            <Code c="rcs_unreachable" />.
          </li>
        </Liste>
      </Route>
    </>
  );
}
