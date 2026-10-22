import { z } from 'zod';
import { lireCorpsBorne } from '../lib/corps-borne';
import { texteDe } from '../lib/erreur';
import { fetchPublic } from '../lib/connexion-publique';
import { API_VERSION_SHOPIFY } from './connexion';
import { telephoneE164 } from './donnees';

/**
 * LES CLIENTS ABONNÉS D'UNE BOUTIQUE, lus chez Shopify pour l'import (plan 2026-10-21, lot 3, décisions de Julien du
 * 2026-10-22) : seuls les clients abonnés au marketing, par e-mail ou par SMS, avec un téléphone valable, du plus
 * récent au plus ancien.
 *
 * Mesuré le 2026-10-22 (API 2026-10) : l'abonnement est dans `defaultEmailAddress.marketingState` et
 * `defaultPhoneNumber.marketingState` (`SUBSCRIBED`), le téléphone du client dans `defaultPhoneNumber.phoneNumber`.
 * 🔴 SEUL CE TÉLÉPHONE-LÀ (relecture du lot 3) : celui d'une adresse peut être celui d'un destinataire, et une demande
 * d'effacement (`customers/redact`) ne porte que celui du client ; une fiche importée par l'adresse n'y serait pas
 * retrouvée.
 * 🔴 UN FILTRE DE RECHERCHE INCONNU EST IGNORÉ EN SILENCE (`email_subscription_status:SUBSCRIBED` rendait tout le
 * monde, et `customersCount` ignore tout filtre) : le filtre envoyé ne sert qu'à lire moins de pages, l'abonnement se
 * REVÉRIFIE sur chaque client lu. Sans cette revérification, un filtre ignoré importerait toute la boutique.
 *
 * 🔴 Le corps vient d'un tiers : chaque page passe à `safeParse`, jamais à `as`.
 */

/** Une page de clients : 35 points demandés sur un seau de 2 000, rechargé de 100 par seconde (mesuré). */
const PAR_PAGE = 250;
const CORPS_MAX = 2_000_000;
const DELAI_MS = 20_000;
/** Les attentes successives quand Shopify freine (`THROTTLED`), au-delà desquelles la lecture s'arrête. */
const ESSAIS_FREIN = 5;
/**
 * Le temps de lecture d'un appel (relecture du lot 3) : le proxy de l'API coupe une réponse à 45 s. Au-delà, l'outil
 * rendrait un échec pendant que l'import s'écrit, et le relancer importerait plus que le nombre choisi. La lecture
 * s'arrête donc avant, en le disant (`complet: false`) ; l'import est relançable.
 */
export const BUDGET_LECTURE_MS = 25_000;
const NOM_MAX = 200;

export const FILTRE_ABONNES = 'email_marketing_state:SUBSCRIBED OR sms_marketing_state:SUBSCRIBED';

const REQUETE = `query($q: String, $apres: String) {
  customers(first: ${PAR_PAGE}, after: $apres, query: $q, sortKey: CREATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    nodes {
      firstName lastName
      defaultPhoneNumber { phoneNumber marketingState }
      defaultEmailAddress { marketingState }
    }
  }
}`;

const texte = z.string().nullish();
const schemaPage = z.object({
  data: z.object({
    customers: z.object({
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: texte }),
      nodes: z.array(z.object({
        firstName: texte,
        lastName: texte,
        defaultPhoneNumber: z.object({ phoneNumber: texte, marketingState: texte }).nullish(),
        defaultEmailAddress: z.object({ marketingState: texte }).nullish(),
      })),
    }),
  }).nullish(),
  errors: z.array(z.object({ message: z.string(), extensions: z.object({ code: texte }).passthrough().nullish() })).nullish(),
  extensions: z.object({
    cost: z.object({
      requestedQueryCost: z.number().nullish(),
      throttleStatus: z.object({ currentlyAvailable: z.number(), restoreRate: z.number() }).nullish(),
    }).nullish(),
  }).nullish(),
});
type Noeud = NonNullable<z.infer<typeof schemaPage>['data']>['customers']['nodes'][number];

export interface ClientAbonne {
  telephone: string;
  nom: string | null;
}

export type LectureClients =
  | {
    ok: true;
    /** Les abonnés avec un téléphone valable, du plus récent au plus ancien, un par numéro. */
    abonnes: ClientAbonne[];
    /** Les abonnés lus sans téléphone valable : comptés, jamais importés. */
    sansTelephone: number;
    /** `false` quand la lecture s'est arrêtée au plafond : il y a d'autres abonnés, plus anciens. */
    complet: boolean;
  }
  | { ok: false; code: 'acces_refuse' | 'passager'; message: string };

export interface AccesClients {
  domaine: string;
  jeton: string;
  /** Le pays de la boutique, pour un téléphone saisi sans indicatif. */
  pays: string | null;
}

/** L'abonnement, revérifié sur le client lui-même, quel que soit le filtre envoyé. */
export function estAbonne(n: Pick<Noeud, 'defaultPhoneNumber' | 'defaultEmailAddress'>): boolean {
  return n.defaultEmailAddress?.marketingState === 'SUBSCRIBED' || n.defaultPhoneNumber?.marketingState === 'SUBSCRIBED';
}

function nomDe(n: Noeud): string | null {
  const nom = [n.firstName, n.lastName].filter((x): x is string => typeof x === 'string' && x.trim() !== '').join(' ').replace(/\s+/g, ' ').trim();
  return nom === '' ? null : nom.slice(0, NOM_MAX);
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Lit les abonnés page par page, jusqu'à `plafond` clients LUS (abonnés ou non). Un freinage de Shopify attend que le
 * seau se recharge ; un accès refusé (les données client protégées d'une boutique en production) se dit tel quel.
 */
export async function lireClientsAbonnes(
  acces: AccesClients,
  plafond: number,
  /** `fetchPublic`, une vraie attente et la vraie horloge en production ; injectables pour éprouver la lecture. */
  appeler: typeof fetch = fetchPublic,
  attendre: (ms: number) => Promise<void> = pause,
  horloge: () => number = Date.now,
): Promise<LectureClients> {
  const debut = horloge();
  const abonnes: ClientAbonne[] = [];
  const vus = new Set<string>();
  let sansTelephone = 0;
  let lus = 0;
  let apres: string | null = null;
  let freins = 0;
  for (;;) {
    let page: z.infer<typeof schemaPage>;
    try {
      const res = await appeler(`https://${acces.domaine}/admin/api/${API_VERSION_SHOPIFY}/graphql.json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-shopify-access-token': acces.jeton },
        body: JSON.stringify({ query: REQUETE, variables: { q: FILTRE_ABONNES, apres } }),
        redirect: 'manual',
        signal: AbortSignal.timeout(DELAI_MS),
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, code: 'acces_refuse', message: `Shopify refuse la lecture des clients (statut ${res.status}) : l’app doit avoir l’accès read_customers, et sur une boutique en production l’accès aux données client protégées.` };
      }
      const corps = await lireCorpsBorne(res, CORPS_MAX);
      if (corps.trop_gros || corps.casse) return { ok: false, code: 'passager', message: 'Shopify a rendu une page de clients illisible : réessayez dans un instant.' };
      const lu = schemaPage.safeParse(JSON.parse(corps.texte));
      if (res.status !== 200 || !lu.success) {
        return { ok: false, code: 'passager', message: `Shopify n’a pas rendu la liste des clients (statut ${res.status}) : réessayez dans un instant.` };
      }
      page = lu.data;
    } catch (err) {
      return { ok: false, code: 'passager', message: `Shopify n’a pas répondu (${texteDe(err)}) : réessayez dans un instant.` };
    }

    const seau = page.extensions?.cost?.throttleStatus;
    const cout = page.extensions?.cost?.requestedQueryCost ?? 0;
    const attenteMs = seau && seau.restoreRate > 0 ? Math.ceil(Math.max(0, cout - seau.currentlyAvailable) / seau.restoreRate) * 1000 : 1000;
    if (page.errors?.some((e) => e.extensions?.code === 'THROTTLED')) {
      freins += 1;
      if (freins > ESSAIS_FREIN || horloge() - debut + attenteMs > BUDGET_LECTURE_MS) {
        return { ok: false, code: 'passager', message: 'Shopify freine la lecture des clients : réessayez dans une minute.' };
      }
      await attendre(Math.max(1000, attenteMs));
      continue;
    }
    if (page.errors && page.errors.length > 0) {
      const refuse = page.errors.some((e) => e.extensions?.code === 'ACCESS_DENIED' || /access denied/i.test(e.message));
      return refuse
        ? { ok: false, code: 'acces_refuse', message: 'Shopify refuse la lecture des clients : sur une boutique en production, l’app doit déclarer l’accès aux données client protégées (nom, téléphone, e-mail).' }
        : { ok: false, code: 'passager', message: `Shopify refuse la requête des clients (${page.errors[0]!.message.slice(0, 200)}).` };
    }
    if (!page.data) return { ok: false, code: 'passager', message: 'Shopify n’a pas rendu la liste des clients : réessayez dans un instant.' };
    freins = 0;

    for (const n of page.data.customers.nodes) {
      lus += 1;
      if (!estAbonne(n)) continue;
      const telephone = telephoneE164([{ brut: n.defaultPhoneNumber?.phoneNumber }], acces.pays);
      if (telephone === null) {
        sansTelephone += 1;
        continue;
      }
      if (vus.has(telephone)) continue;
      vus.add(telephone);
      abonnes.push({ telephone, nom: nomDe(n) });
    }

    const { hasNextPage, endCursor } = page.data.customers.pageInfo;
    if (!hasNextPage || !endCursor) return { ok: true, abonnes, sansTelephone, complet: true };
    if (lus >= plafond || horloge() - debut >= BUDGET_LECTURE_MS) return { ok: true, abonnes, sansTelephone, complet: false };
    apres = endCursor;
    // Le seau presque vide : attendre AVANT la page suivante plutôt que de se faire freiner.
    if (seau && seau.currentlyAvailable < cout * 2) await attendre(attenteMs);
  }
}
