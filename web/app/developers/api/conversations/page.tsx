'use client';

import { CadreDoc } from '@/components/doc-api/CadreDoc';
import {
  Bloc, C, Encadre, EnTetePage, LienDoc, Liste, Route, Section, Sous, SurCettePage, Tableau, curlGet, json,
} from '@/components/doc-api/elements';
import { useT } from '@/lib/i18n';
import { EXEMPLES_REPONSES } from '@/lib/api-exemples';

/**
 * LA LECTURE DES FILS (lot 13, domaine 1) : les conversations de l'espace, leurs messages, un message, le fichier d'un
 * message reçu. Les formes viennent des exemples tenus aux types du serveur (`tests/api-exemples.test.ts`).
 */
export default function ApiConversationsPage() {
  return <CadreDoc page="conversations">{() => <Conversations />}</CadreDoc>;
}

const CONVERSATION = 'c4e1b2a3-9d8f-4e7a-a6b5-1c2d3e4f5a6b';

function Conversations() {
  const t = useT();
  const commande = t('Commande', 'Command');
  const reponse = t('Réponse 200', '200 response');
  const entetes = [t('Champ', 'Field'), t('Sens', 'Meaning')];
  return (
    <>
      <EnTetePage page="conversations">
        <p>
          {t(
            'Ce que vos contacts ont écrit et ce qui leur a été répondu, pour qu’une application réponde avec le contexte. Ouvert dans toutes les offres, sous le droit conversations:read, à cocher sur une clé neuve : les clés créées avant ce droit ne l’ont pas.',
            'What your contacts wrote and what was answered, so that an app replies with the context. Open in every plan, under the conversations:read scope, to tick on a new key: keys created before this scope do not have it.',
          )}
        </p>
      </EnTetePage>
      <SurCettePage page="conversations" />

      <Route ep="GET /v1/conversations">
        <Bloc legende={commande}>{curlGet('/v1/conversations?limit=20')}</Bloc>
        <Sous>{reponse}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.conversations)}</Bloc>
        <Tableau
          entetes={entetes}
          lignes={[
            { cle: 'needsReply', cellules: [<C key="c">needsReply=true</C>, t('Seulement les conversations « À traiter » : le contact attend une réponse de l’ÉQUIPE. Celles que tient votre application (mode « mon application répond ») n’y sont pas : elles arrivent par l’événement conversation.needs_reply.', 'Only conversations “To handle”: the contact awaits an answer from the TEAM. Those your app handles (“my app answers” mode) are not there: they come through the conversation.needs_reply event.')] },
            { cle: 'handledBy', cellules: [<C key="c">handledBy</C>, t('Qui tient la conversation : team (l’équipe), meta_agent (l’agent de Meta), automation (un scénario, un agent IA, ou votre application).', 'Who handles the conversation: team, meta_agent (Meta’s agent), automation (a scenario, an AI agent, or your app).')] },
            { cle: 'windowExpiresAt', cellules: [<C key="c">windowExpiresAt</C>, t('La fin de la fenêtre de 24 h ouverte par le dernier message WhatsApp du contact ; null si elle est fermée.', 'The end of the 24-hour window opened by the contact’s last WhatsApp message; null when closed.')] },
          ]}
        />
      </Route>

      <Route ep="GET /v1/conversations/{conversationId}">
        <Bloc legende={commande}>{curlGet(`/v1/conversations/${CONVERSATION}`)}</Bloc>
        <Sous>{reponse}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.conversationLue)}</Bloc>
        <p>{t('Une conversation d’un autre espace, ou d’un contact bloqué, rend 404 conversation_not_found.', 'A conversation of another workspace, or of a blocked contact, returns 404 conversation_not_found.')}</p>
      </Route>

      <Route ep="GET /v1/conversations/{conversationId}/messages">
        <Bloc legende={commande}>{curlGet(`/v1/conversations/${CONVERSATION}/messages?limit=50`)}</Bloc>
        <Sous>{reponse}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.messagesDuFil)}</Bloc>
        <Tableau
          entetes={entetes}
          lignes={[
            { cle: 'id', cellules: [<C key="c">id</C>, t('L’identifiant de Meta (wamid.…), le même que rendent POST /v1/messages/whatsapp, message.received et conversation.needs_reply.', 'Meta’s ID (wamid.…), the same as returned by POST /v1/messages/whatsapp, message.received and conversation.needs_reply.')] },
            { cle: 'media', cellules: [<C key="c">media</C>, t('Un fichier reçu (image, vocal, document) ; null sinon. expired : Meta ne l’a plus.', 'A received file (image, voice note, document); null otherwise. expired: Meta no longer has it.')] },
            { cle: 'transcription', cellules: [<C key="c">transcription</C>, t('La transcription d’un vocal, quand elle a été faite : la lecture d’un modèle, pas ce que le client a dit.', 'A voice note’s transcription, when made: a model’s reading, not what the customer said.')] },
          ]}
        />
      </Route>

      <Route ep="GET /v1/messages/{messageId}">
        <Bloc legende={commande}>{curlGet('/v1/messages/wamid.exemple-9031')}</Bloc>
        <Sous>{reponse}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.messageLu)}</Bloc>
      </Route>

      <Route ep="GET /v1/messages/{messageId}/media">
        <Bloc legende={commande}>{`${curlGet('/v1/messages/wamid.exemple-9031/media')} \\\n  --output photo.jpg`}</Bloc>
        <p>{t('Les octets du fichier, avec son type (Content-Type). Les erreurs :', 'The file’s bytes, with its type (Content-Type). The errors:')}</p>
        <Liste>
          <li>{t('404 no_media : le message ne porte aucun fichier reçu ;', '404 no_media: the message carries no received file;')}</li>
          <li>{t('410 media_expired : Meta ne garde un fichier reçu que 7 jours, téléchargez-le avant ;', '410 media_expired: Meta keeps a received file for 7 days only, download it before;')}</li>
          <li>{t('422 media_unavailable : Meta ne l’a pas rendu, ou il est trop lourd ; réessayez.', '422 media_unavailable: Meta did not return it, or it is too large; retry.')}</li>
        </Liste>
      </Route>

      <Section id="pagination" titre={t('Pagination', 'Pagination')}>
        <Liste>
          <li>{t('limit : de 1 à 100, 50 par défaut. Le plus récent d’abord.', 'limit: 1 to 100, 50 by default. Most recent first.')}</li>
          <li>{t('nextCursor : à renvoyer tel quel dans cursor pour la page suivante (plus ancienne) ; null quand il n’y en a plus.', 'nextCursor: send it back as is in cursor for the next (older) page; null when there is none.')}</li>
          <li>{t('Un curseur modifié rend 400 invalid_cursor, jamais une page qui recommence au début.', 'A modified cursor returns 400 invalid_cursor, never a page that starts over.')}</li>
        </Liste>
        <Encadre sorte="note">
          <p>
            {t('Chaque appel compte au plafond d’appels de l’espace, pas au quota du jour.', 'Each call counts toward the workspace call cap, not the daily quota.')}{' '}
            <LienDoc page="reference" ancre="debit">{t('Débit', 'Rate limits')}</LienDoc>
          </p>
        </Encadre>
      </Section>
    </>
  );
}
