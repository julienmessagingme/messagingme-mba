import { z } from 'zod';
import { lireCorpsBorne } from '../lib/corps-borne';
import { texteDe } from '../lib/erreur';
import { fetchPublic } from '../lib/connexion-publique';
import { API_VERSION_SHOPIFY } from './connexion';

/**
 * L'ABONNEMENT DES WEBHOOKS D'UNE BOUTIQUE BRANCHÉE PAR LA CONSOLE (conception 2026-10-22, plan lot 1).
 *
 * L'app créée à la main sur le tableau de bord de Shopify n'a aucun écran pour ses webhooks : sans la CLI, ils
 * s'abonnent par l'API, boutique par boutique (doc de Shopify). C'est donc NOTRE serveur qui le fait au branchement,
 * avec le jeton `client_credentials` de l'app. Mesuré le 2026-10-22 sur la boutique de dev : les six sujets s'abonnent ;
 * un sujet déjà abonné est refusé (« Address for this topic has already been taken »), ce qui rend l'abonnement
 * idempotent de lui-même : ce refus-là vaut « déjà ».
 *
 * 🔴 JAMAIS pour une boutique de Claude Code : ses webhooks sont déclarés dans l'app (`shopify.app.toml`), et les doubler
 * ferait tout recevoir deux fois. Les sujets RGPD ne s'abonnent pas par l'API (doc de Shopify) : une boutique de la
 * console ne reçoit pas les demandes d'effacement, le marchand efface à la main (décision de Julien).
 */

export const ADRESSE_WEBHOOKS = 'https://api.messagingme.app/shopify/webhooks';
/** Les sujets de `shopify.app.toml`, sans les sujets RGPD, au format de l'API (`WebhookSubscriptionTopic`). */
export const SUJETS_ABONNES = ['ORDERS_CREATE', 'ORDERS_PAID', 'FULFILLMENTS_CREATE', 'CHECKOUTS_CREATE', 'CHECKOUTS_UPDATE', 'APP_UNINSTALLED'] as const;

const DELAI_MS = 10_000;
const CORPS_MAX = 64_000;
const DEJA_PRIS = /already been taken/i;

const MUTATION = `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { id } userErrors { field message } }
}`;

const schemaReponse = z.object({
  data: z.object({
    webhookSubscriptionCreate: z.object({
      webhookSubscription: z.object({ id: z.string() }).nullish(),
      userErrors: z.array(z.object({ message: z.string() })),
    }).nullish(),
  }).nullish(),
  errors: z.array(z.object({ message: z.string() })).nullish(),
});

export type IssueAbonnement =
  | { ok: true; abonnes: string[]; deja: string[] }
  | { ok: false; message: string };

/** Abonne les six sujets ; s'arrête au premier refus qui n'est pas « déjà », et le rend avec son sujet. */
export async function abonnerWebhooks(
  acces: { domaine: string; jeton: string },
  /** `fetchPublic` en production : le domaine vient du marchand. Injectable pour éprouver sans réseau. */
  appeler: typeof fetch = fetchPublic,
): Promise<IssueAbonnement> {
  const abonnes: string[] = [];
  const deja: string[] = [];
  for (const sujet of SUJETS_ABONNES) {
    let lu: z.infer<typeof schemaReponse>;
    try {
      const res = await appeler(`https://${acces.domaine}/admin/api/${API_VERSION_SHOPIFY}/graphql.json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-shopify-access-token': acces.jeton },
        body: JSON.stringify({ query: MUTATION, variables: { topic: sujet, sub: { uri: ADRESSE_WEBHOOKS } } }),
        redirect: 'manual',
        signal: AbortSignal.timeout(DELAI_MS),
      });
      const corps = await lireCorpsBorne(res, CORPS_MAX);
      const p = corps.trop_gros || corps.casse ? null : schemaReponse.safeParse(JSON.parse(corps.texte));
      if (res.status !== 200 || !p?.success) {
        return { ok: false, message: `Shopify n’a pas abonné les événements de la boutique (${sujet}, statut ${res.status}) : réessayez dans un instant.` };
      }
      lu = p.data;
    } catch (err) {
      return { ok: false, message: `Shopify n’a pas répondu (${texteDe(err)}) : réessayez dans un instant.` };
    }
    if (lu.errors && lu.errors.length > 0) {
      return { ok: false, message: `Shopify refuse l’abonnement aux événements (${sujet} : ${lu.errors[0]!.message.slice(0, 200)}).` };
    }
    const r = lu.data?.webhookSubscriptionCreate;
    if (r?.webhookSubscription?.id) abonnes.push(sujet);
    else if (r?.userErrors.some((e) => DEJA_PRIS.test(e.message))) deja.push(sujet);
    else {
      return { ok: false, message: `Shopify refuse l’abonnement aux événements (${sujet} : ${(r?.userErrors[0]?.message ?? 'réponse vide').slice(0, 200)}).` };
    }
  }
  return { ok: true, abonnes, deja };
}
