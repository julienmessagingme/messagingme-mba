'use client';

import { CadreDoc } from '@/components/doc-api/CadreDoc';
import {
  Bloc, Encadre, EnTetePage, Erreurs, LienDoc, Liste, Route, Sous, SurCettePage, curl, curlGet, json,
} from '@/components/doc-api/elements';
import { useT } from '@/lib/i18n';
import { EXEMPLES_CORPS, EXEMPLES_REPONSES } from '@/lib/api-exemples';

/**
 * GÉRER LES WEBHOOKS SORTANTS PAR L'API (lot 13, domaine 4) : les mêmes adresses que Developers > Webhooks sortants,
 * par une clé `webhooks:write`. Le format des événements, la signature et les réessais vivent sur la page `webhooks`.
 */
export default function ApiWebhookEndpointsPage() {
  return <CadreDoc page="webhook-endpoints">{() => <Gestion />}</CadreDoc>;
}

function Gestion() {
  const t = useT();
  const commande = t('Commande', 'Command');
  const reponse = t('Réponse', 'Response');
  const erreurs = t('Erreurs', 'Errors');
  const inconnue = t('Adresse inconnue de cet espace.', 'Endpoint unknown to this workspace.');

  return (
    <>
      <EnTetePage page="webhook-endpoints">
        <p>
          {t(
            'Les adresses de votre application qui reçoivent les événements, gérées par une clé portant le droit webhooks:write. Ce sont les mêmes que dans Developers > Webhooks sortants, avec les mêmes contrôles et la même limite de l’offre. Le format des événements :',
            'The endpoints of your app that receive the events, managed by a key with the webhooks:write scope. They are the same as in Developers > Outgoing webhooks, with the same checks and the same plan limit. The event format:',
          )}{' '}
          <LienDoc page="webhooks">{t('Webhooks sortants', 'Outgoing webhooks')}</LienDoc>.
        </p>
      </EnTetePage>
      <SurCettePage page="webhook-endpoints" />

      <Route ep="GET /v1/webhooks">
        <Bloc legende={commande}>{curlGet('/v1/webhooks')}</Bloc>
        <Sous>{t('Réponse 200', '200 response')}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.webhooks)}</Bloc>
        <p>{t('limit : les adresses actives de l’offre, null sans limite. Le secret n’est jamais relu.', 'limit: the plan’s active endpoints, null without a limit. The secret is never read back.')}</p>
      </Route>

      <Route ep="POST /v1/webhooks">
        <Bloc legende={commande}>{curl('/v1/webhooks', EXEMPLES_CORPS.webhookCree.corps)}</Bloc>
        <Sous>{t('Réponse 201', '201 response')}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.webhookCree)}</Bloc>
        <Encadre sorte="attention">
          <p>{t('Le secret n’est montré qu’ici : rangez-le dans une variable d’environnement de votre application.', 'The secret is only shown here: store it in an environment variable of your app.')}</p>
        </Encadre>
        <Liste>
          <li>{t('url : https, joignable depuis Internet. Elle ne se modifie pas ensuite : supprimez et recréez.', 'url: https, reachable from the Internet. It cannot be changed later: delete and recreate.')}</li>
          <li>{t('types : absents, tous sauf les trois accusés de livraison.', 'types: absent, all except the three delivery receipts.')}</li>
        </Liste>
        <Sous>{erreurs}</Sous>
        <Erreurs
          lignes={[
            ['invalid_body', t('Corps hors du format, ou adresse refusée (http, hôte interne).', 'Body outside the format, or address refused (http, internal host).')],
            ['plan_limit_reached', t('Limite d’adresses actives de l’offre atteinte.', 'The plan’s active endpoint limit is reached.')],
          ]}
        />
      </Route>

      <Route ep="GET /v1/webhooks/{webhookId}">
        <Sous>{t('Réponse 200', '200 response')}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.webhook)}</Bloc>
        <Erreurs lignes={[['webhook_not_found', inconnue]]} />
      </Route>

      <Route ep="PATCH /v1/webhooks/{webhookId}">
        <p>{t('active à false met l’adresse en pause ; true la rallume, dans la limite de l’offre.', 'active false pauses the endpoint; true turns it back on, within the plan limit.')}</p>
        <Bloc legende={t('Corps', 'Body')}>{json(EXEMPLES_CORPS.webhookEnPause.corps)}</Bloc>
        <Sous>{reponse}</Sous>
        <p>{t('L’adresse, comme GET /v1/webhooks/{webhookId}.', 'The endpoint, as GET /v1/webhooks/{webhookId}.')}</p>
        <Erreurs lignes={[['invalid_body', t('Corps hors du format.', 'Body outside the format.')], ['webhook_not_found', inconnue], ['plan_limit_reached', t('Réactivation au-delà de la limite de l’offre.', 'Reactivation beyond the plan limit.')]]} />
      </Route>

      <Route ep="POST /v1/webhooks/{webhookId}/rotate-secret">
        <p>{t('Rend { secret, previousSecretValidUntil } : l’ancien secret signe encore 24 h, le temps de mettre à jour l’application.', 'Returns { secret, previousSecretValidUntil }: the old secret still signs for 24 h, while you update the app.')}</p>
        <Erreurs lignes={[['webhook_not_found', inconnue]]} />
      </Route>

      <Route ep="DELETE /v1/webhooks/{webhookId}">
        <p>{t('204 sans corps. Les envois en cours de cette adresse s’arrêtent.', '204 without a body. The endpoint’s pending deliveries stop.')}</p>
        <Erreurs lignes={[['webhook_not_found', inconnue]]} />
      </Route>

      <Route ep="POST /v1/webhooks/{webhookId}/test">
        <p>{t('Envoie tout de suite un événement test signé, même à une adresse en pause, et rend { eventId, delivered, statusCode, response }.', 'Sends a signed test event right away, even to a paused endpoint, and returns { eventId, delivered, statusCode, response }.')}</p>
        <Erreurs lignes={[['webhook_not_found', inconnue]]} />
      </Route>

      <Route ep="GET /v1/webhooks/{webhookId}/deliveries">
        <Bloc legende={commande}>{curlGet('/v1/webhooks/{webhookId}/deliveries?limit=20')}</Bloc>
        <Sous>{t('Réponse 200', '200 response')}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.envoisWebhook)}</Bloc>
        <Liste>
          <li>{t('limit : 1 à 100, 50 par défaut. before : une date ISO, celle que rend nextBefore pour la page suivante.', 'limit: 1 to 100, 50 by default. before: an ISO date, the one nextBefore returns for the next page.')}</li>
          <li>{t('status : pending (en cours ou en réessai), delivered, failed. body : le corps envoyé, octet pour octet ; il porte des données de contacts.', 'status: pending (in progress or retrying), delivered, failed. body: the body sent, byte for byte; it carries contact data.')}</li>
        </Liste>
        <Erreurs lignes={[['invalid_body', t('limit ou before hors du format.', 'limit or before outside the format.')], ['webhook_not_found', inconnue]]} />
      </Route>

      <Route ep="POST /v1/webhooks/deliveries/{deliveryId}/replay">
        <p>{t('202 { replayed: true } : l’envoi repart avec le même corps et le même identifiant d’événement (votre application dédoublonne).', '202 { replayed: true }: the delivery goes again with the same body and the same event id (your app deduplicates).')}</p>
        <Erreurs lignes={[['delivery_not_found', t('Identifiant qui n’est pas celui d’un envoi.', 'Identifier that is not a delivery id.')], ['delivery_not_replayable', t('Envoi inconnu de cet espace, encore en cours, ou un essai : rien à rejouer.', 'Delivery unknown to this workspace, still pending, or a test: nothing to replay.')]]} />
      </Route>

      <Route ep="POST /v1/webhooks/{webhookId}/replay-failures">
        <Bloc legende={commande}>{curl('/v1/webhooks/{webhookId}/replay-failures', EXEMPLES_CORPS.rejeuEchecs.corps)}</Bloc>
        <p>{t('202 { replayed } : le nombre d’envois en échec relancés depuis since, 500 au plus par appel.', '202 { replayed }: the number of failed deliveries replayed since since, 500 at most per call.')}</p>
        <Erreurs lignes={[['invalid_body', t('since absent ou hors du format.', 'since missing or outside the format.')], ['webhook_not_found', inconnue]]} />
      </Route>
    </>
  );
}
