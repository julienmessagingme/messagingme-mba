import { z } from 'zod';
import { ClientGraph } from './graph';
import { messageDe } from '../lib/erreur';

/**
 * Client Graph des publicités Click-to-WhatsApp (connexion) ; l'appel Graph, l'échange du code et la lecture
 * des cibles d'un jeton viennent de `ClientGraph`. Toute réponse de Meta passe par un `safeParse`, jamais un `as`.
 */

/** Un compte publicitaire accordé, avec ce que Meta en dit dans la même réponse. */
export interface ComptePubAccorde {
  /** Sans le préfixe `act_` : les appels l'ajoutent, l'écran et la base gardent la forme nue. */
  id: string;
  nom: string | null;
  devise: string | null;
  fuseau: string | null;
  /** `account_status` de Meta. 1 = actif ; tout le reste empêche de diffuser (désactivé, impayé...). */
  statut: number | null;
}

/**
 * Ce qui empêche, ou non, de diffuser. Lu en direct à l'ouverture de l'écran, jamais mémorisé : un indicateur
 * de disponibilité qui date ne sert à rien.
 */
export interface EtatComptePub {
  /** `account_status` : 1 = actif. Tout le reste empêche de diffuser. */
  statut: number | null;
  /** `disable_reason` : 0 quand rien ne cloche. */
  raisonDesactivation: number | null;
  /** Un moyen de paiement est rattaché (`funding_source_details`). Sans lui, la diffusion ne part pas. */
  moyenPaiement: boolean;
}

export interface PageAccordee {
  id: string;
  nom: string | null;
}

/** Ce que le jeton du client accorde, lu aux points d'entrée dédiés (cf. `actifsAccordes`). */
export interface ActifsAccordes {
  comptesPub: ComptePubAccorde[];
  pages: PageAccordee[];
}

/**
 * La Page est-elle liée au compte WhatsApp de l'espace ? Aucun code ne calcule ce verdict, qui vaut `inconnu`
 * partout : Meta affiche la liaison dans son interface mais ne l'expose par aucune API (champs essayés sur le
 * numéro et sur la Page, tous absents ou vides). Le type garde trois valeurs pour le jour où elle le sera :
 * « Meta ne sait pas répondre » n'est pas « non liée », qui enverrait refaire une liaison existante.
 */
export type LiaisonPage = 'oui' | 'non' | 'inconnu';

/** Les listes de Graph. Tout est optionnel sauf l'identifiant : on ne suppose rien du reste. */
const listeComptesSchema = z.object({
  data: z.array(z.object({
    id: z.string(),
    name: z.string().optional(),
    currency: z.string().optional(),
    timezone_name: z.string().optional(),
    account_status: z.number().optional(),
  })).optional(),
});

const etatCompteSchema = z.object({
  account_status: z.number().optional(),
  disable_reason: z.number().optional(),
  funding_source_details: z.object({ id: z.string().optional() }).optional(),
});

const listePagesSchema = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string().optional() })).optional(),
});

/**
 * Les permissions retirées à la déconnexion, et elles seules : celles qui n'ont aucun usage hors publicité
 * dans cette application.
 */
const PERMISSIONS_PUB = ['ads_management', 'ads_read', 'pages_manage_ads'] as const;

/** `GET /me?fields=id` : l'entité qui porte le jeton. */
const identiteSchema = z.object({ id: z.string() });

/** `GET /{ad-id}?fields=campaign_id`. `campaign_id` optionnel : on ne suppose rien de la réponse. */
const campagneDeLaPubSchema = z.object({ campaign_id: z.string().optional() });

/**
 * Plafond de durée de la résolution d'une pub (3 s), bien plus court que le plafond Graph ordinaire : cet appel
 * est sur le chemin chaud d'un message entrant, derrière lequel attendent l'inbox, les scénarios et les autres
 * messages du lot. Le dépasser n'est pas une panne : le lead suit le chemin ordinaire, et la résolution sera
 * retentée au prochain lead de la même pub.
 */
export const DELAI_RESOLUTION_PUB_MS = 3000;

export class MetaPubsClient extends ClientGraph {
  /**
   * Les comptes publicitaires et les Pages que le jeton accorde, lus à `GET /me/adaccounts` et `GET /me/accounts`
   * (devise et fuseau compris). Surtout pas `debug_token` : pour un utilisateur système, Meta rend les scopes sans
   * `target_ids`, donc deux listes vides sur une connexion parfaite. Une liste vide n'est pas une erreur (un
   * client peut n'avoir accordé qu'une Page) : la route la traduit.
   */
  async actifsAccordes(jeton: string): Promise<ActifsAccordes> {
    const entete = { headers: { Authorization: `Bearer ${jeton}` } };
    const brutComptes = await this.call(
      `${this.baseUrl}/${this.version}/me/adaccounts?fields=id,name,currency,timezone_name,account_status&limit=100`, entete);
    const brutPages = await this.call(`${this.baseUrl}/${this.version}/me/accounts?fields=id,name&limit=100`, entete);
    const luComptes = listeComptesSchema.safeParse(brutComptes);
    const luPages = listePagesSchema.safeParse(brutPages);
    return {
      comptesPub: (luComptes.success ? luComptes.data.data ?? [] : []).map((c) => ({
        id: sansPrefixeAct(c.id),
        nom: c.name ?? null,
        devise: c.currency ?? null,
        fuseau: c.timezone_name ?? null,
        statut: c.account_status ?? null,
      })),
      pages: (luPages.success ? luPages.data.data ?? [] : []).map((p) => ({ id: p.id, nom: p.name ?? null })),
    };
  }

  /**
   * L'état du compte publicitaire : peut-il diffuser aujourd'hui ? `funding_source_details` dit qu'un moyen de
   * paiement est rattaché ; sans lui, une pub se crée mais ne part jamais. Lisible avec la tâche ADVERTISE.
   */
  async etatCompte(comptePubId: string, jeton: string): Promise<EtatComptePub> {
    const qs = new URLSearchParams({ fields: 'account_status,disable_reason,funding_source_details' });
    const brut = await this.call(
      `${this.baseUrl}/${this.version}/act_${encodeURIComponent(sansPrefixeAct(comptePubId))}?${qs.toString()}`,
      { headers: { Authorization: `Bearer ${jeton}` } },
    );
    const lu = etatCompteSchema.safeParse(brut);
    if (!lu.success) return { statut: null, raisonDesactivation: null, moyenPaiement: false };
    return {
      statut: lu.data.account_status ?? null,
      raisonDesactivation: lu.data.disable_reason ?? null,
      moyenPaiement: (lu.data.funding_source_details?.id ?? '') !== '',
    };
  }

  /**
   * La campagne d'une publicité (`GET /{ad-id}?fields=campaign_id`) ; `null` si Meta n'a pas répondu, a refusé ou
   * a dépassé trois secondes. Le webhook ne porte que l'identifiant de la pub, le lien est par campagne : une pub
   * dupliquée dans le Gestionnaire route ainsi comme l'originale (résultat mémorisé dans `pubs_connues`).
   * Ne lève jamais : l'appelant est le chemin d'un message entrant. Le plafond passe par `delaiMs`, donc le message
   * d'abandon de `ClientGraph.call` dit bien trois secondes.
   */
  async campagneDeLaPub(adId: string, jeton: string): Promise<string | null> {
    try {
      const brut = await this.call(`${this.baseUrl}/${this.version}/${encodeURIComponent(adId)}?fields=campaign_id`, {
        headers: { Authorization: `Bearer ${jeton}` },
      }, DELAI_RESOLUTION_PUB_MS);
      const lu = campagneDeLaPubSchema.safeParse(brut);
      return lu.success ? lu.data.campaign_id ?? null : null;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`campagne de la publicité ${adId} non résolue (plafond ${DELAI_RESOLUTION_PUB_MS} ms) :`, messageDe(err));
      return null;
    }
  }

  /**
   * Qui porte ce jeton chez Meta (`GET /me`), ou `null` si Meta ne répond pas. Ce qui rend `revoquerAcces` sûr sur
   * un remplacement : `DELETE /me/permissions/<perm>` porte sur le couple (application, entité), pas sur le jeton,
   * et deux jetons du même utilisateur système se révoquent ensemble. On compare avant de révoquer.
   */
  async identite(jeton: string): Promise<string | null> {
    try {
      const brut = await this.call(`${this.baseUrl}/${this.version}/me?fields=id`, {
        headers: { Authorization: `Bearer ${jeton}` },
      });
      const lu = identiteSchema.safeParse(brut);
      return lu.success ? lu.data.id : null;
    } catch {
      // Un jeton déjà mort ne répond pas : `null`, et l'appelant en tire qu'il ne sait pas comparer.
      return null;
    }
  }

  /**
   * Retire nos accès publicitaires chez Meta, permission par permission.
   * 🔴 Surtout pas `DELETE /me/permissions` sans argument, qui désautorise l'application entière : c'est la même
   * application que l'inscription WhatsApp, et « Déconnecter » les publicités couperait les messages du numéro.
   * `business_management`, `pages_show_list` et `pages_read_engagement` restent : elles peuvent servir hors
   * publicité. Le retrait par permission nommée fonctionne sur un jeton d'utilisateur système (HTTP 200).
   */
  async revoquerAcces(jeton: string): Promise<void> {
    // Toutes sont tentées, même après un refus : on retire tout ce qu'on peut et on dit ce qui a résisté.
    const echecs: string[] = [];
    for (const permission of PERMISSIONS_PUB) {
      try {
        await this.call(`${this.baseUrl}/${this.version}/me/permissions/${permission}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${jeton}` },
        });
      } catch (err) {
        echecs.push(`${permission} (${err instanceof Error ? err.message : 'erreur inconnue'})`);
      }
    }
    if (echecs.length > 0) throw new Error(`permissions non retirées : ${echecs.join(', ')}`);
  }
}

/** Ce qui est arrivé à l'ancien jeton d'un remplacement. Le détail de chaque valeur : `src/http/ops.ts`. */
export type SortAncienAcces = 'aucun' | 'retire' | 'meme_entite' | 'indetermine' | 'echec';

/** Ce que `retirerAncienAcces` a besoin de savoir faire. Un objet minuscule, pour qu'un faux tienne en trois lignes. */
export interface ClientRetrait {
  identite(jeton: string): Promise<string | null>;
  revoquerAcces(jeton: string): Promise<void>;
}

/**
 * Retire les permissions de l'ancien jeton quand un dépôt en remplace un, et seulement si c'est sûr.
 * 🔴 `DELETE /me/permissions/<perm>` porte sur l'entité, pas sur le jeton : deux jetons du même utilisateur
 * système se révoquent ensemble, et retirer l'ancien désarmerait le neuf (200 sur une connexion morte).
 * `null` vaut refus des deux côtés : une identité non rendue ne prouve pas une différence. Un échec de retrait
 * n'arrête pas l'appelant, mais se rend en `echec`, jamais en succès. Fonction exécutable plutôt qu'un `if` du
 * câblage, pour qu'un test en juge la sémantique.
 */
export async function retirerAncienAcces(
  client: ClientRetrait,
  ancienClair: string | null,
  jetonNeuf: string,
): Promise<SortAncienAcces> {
  if (ancienClair === null) return 'aucun';
  const [idAncien, idNeuf] = await Promise.all([client.identite(ancienClair), client.identite(jetonNeuf)]);
  if (idAncien === null || idNeuf === null) return 'indetermine';
  if (idAncien === idNeuf) return 'meme_entite';
  return client.revoquerAcces(ancienClair).then(() => 'retire' as const).catch(() => 'echec' as const);
}

/** `act_123` et `123` désignent le même compte : on garde la forme nue, et les appels remettent le préfixe. */
export function sansPrefixeAct(id: string): string {
  return id.startsWith('act_') ? id.slice(4) : id;
}
