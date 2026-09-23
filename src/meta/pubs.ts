import { z } from 'zod';
import { ClientGraph } from './graph';

/**
 * CLIENT GRAPH DES PUBLICITÉS CLICK-TO-WHATSAPP (lot 2, « Connecter »).
 *
 * L'appel Graph, l'échange du code et la lecture des cibles d'un jeton viennent de `ClientGraph`. Ce fichier
 * ne porte que ce qui appartient aux publicités.
 *
 * 🔴 TOUTE RÉPONSE DE META PASSE PAR UN `safeParse`, jamais un `as`. Ce n'est pas de la précaution
 * décorative : la documentation de Vercel annonçait `id` à la racine quand le serveur le rendait sous
 * `apiKey.id`, et c'est le `safeParse` qui a évité de garder une clé facturée dont on aurait perdu
 * l'identifiant (2026-09-09).
 */

/** Un compte publicitaire accordé, avec ce que Meta en dit dans la même réponse. */
export interface ComptePubAccorde {
  /** SANS le préfixe `act_` : les appels l'ajoutent, et l'écran comme la base gardent la forme nue. */
  id: string;
  nom: string | null;
  devise: string | null;
  fuseau: string | null;
  /** `account_status` de Meta. 1 = actif ; tout le reste empêche de diffuser (désactivé, impayé...). */
  statut: number | null;
}

export interface PageAccordee {
  id: string;
  nom: string | null;
}

/** Ce que le jeton du client accorde, LU AUX POINTS D'ENTRÉE DÉDIÉS (cf. `actifsAccordes`). */
export interface ActifsAccordes {
  comptesPub: ComptePubAccorde[];
  pages: PageAccordee[];
}

/**
 * La Page est-elle liée au compte WhatsApp de l'espace ?
 *
 * 🔴 TROIS VALEURS, ET LA TROISIÈME EST LA PLUS IMPORTANTE. « Meta ne sait pas répondre » n'est pas « la
 * Page n'est pas liée ». Afficher « non liée » sur une ignorance enverrait un client refaire une liaison
 * qui existe déjà, et lui ferait douter d'un écran qui a tort. `inconnu` se dit, il ne se devine pas.
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

const listePagesSchema = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string().optional() })).optional(),
});

/**
 * La Page et son compte WhatsApp lié. Le champ est demandé explicitement ; s'il n'existe pas pour cette
 * Page, ou si Graph refuse de le rendre, la réponse ne le portera pas et le verdict sera `inconnu`.
 */
const pageSchema = z.object({
  connected_whatsapp_business_account: z.object({ id: z.string() }).optional(),
});

/**
 * Les permissions QUE NOUS RETIRONS à la déconnexion, et elles seules : celles qui n'ont aucun usage
 * hors publicité dans cette application.
 */
const PERMISSIONS_PUB = ['ads_management', 'ads_read', 'pages_manage_ads'] as const;

export class MetaPubsClient extends ClientGraph {
  /**
   * Les comptes publicitaires et les Pages que le jeton accorde, lus à `GET /me/adaccounts` et
   * `GET /me/accounts`.
   *
   * 🔴 SURTOUT PAS `debug_token`, ET C'EST UNE MESURE, PAS UN AVIS (2026-09-23, sur le vrai compte d'un
   * client). Cette méthode lisait les `target_ids` des `granular_scopes`, comme le fait l'inscription
   * WhatsApp pour les WABA. Sur un jeton d'utilisateur système d'intégration, Meta rend les scopes
   * **SANS aucun `target_ids`** : les deux listes revenaient donc VIDES alors que la connexion était
   * parfaite, et l'écran disait « la connexion n'a donné accès à aucun compte ». Les mêmes appels aux
   * points d'entrée dédiés rendent le compte, son nom, sa devise, son fuseau et son statut.
   *
   * ⚠️ LA DEVISE ET LE FUSEAU ARRIVENT ICI, ce qui retire un appel : ils étaient relus compte par compte
   * juste après, alors que Meta les donne dans la liste.
   *
   * ⚠️ Une liste vide n'est pas une erreur : un client peut n'avoir accordé qu'une Page. C'est la route
   * qui le traduit, parce qu'elle seule sait ce que l'écran doit dire.
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
   * La Page est-elle liée au compte WhatsApp de l'espace ?
   *
   * 🔴 LE REFUS DE META EST UN `inconnu`, PAS UN `non`. La liaison Page et numéro se fait à la main dans
   * les réglages de la Page, et la documentation dit comment la FAIRE, pas comment la VÉRIFIER. Ce champ
   * est le candidat ; tant qu'il n'a pas été mesuré sur un vrai compte, le seul verdict honnête quand il
   * manque est « je ne sais pas ». Une exception ici n'en est donc pas une : elle se traduit.
   */
  async pageLieeAuCompte(pageId: string, wabaId: string, jeton: string): Promise<LiaisonPage> {
    const qs = new URLSearchParams({ fields: 'connected_whatsapp_business_account' });
    let brut: Record<string, unknown>;
    try {
      brut = await this.call(`${this.baseUrl}/${this.version}/${encodeURIComponent(pageId)}?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${jeton}` },
      });
    } catch {
      return 'inconnu';
    }
    const lu = pageSchema.safeParse(brut);
    if (!lu.success || lu.data.connected_whatsapp_business_account === undefined) return 'inconnu';
    return lu.data.connected_whatsapp_business_account.id === wabaId ? 'oui' : 'non';
  }

  /**
   * RETIRE NOS ACCÈS PUBLICITAIRES CHEZ META, permission par permission.
   *
   * 🔴 SURTOUT PAS `DELETE /me/permissions` SANS ARGUMENT, qui désautorise l'APPLICATION EN ENTIER.
   * Et notre application est la MÊME pour les publicités et pour l'inscription WhatsApp (un seul
   * `META_APP_ID`, seule la configuration difère) : un client qui cliquerait « Déconnecter » sur l'écran
   * Publicités aurait pu perdre l'accès qui fait PARLER son numéro, donc tous ses messages, depuis un bouton
   * qui ne parle que de publicités. Relevé en relecture à froid le 2026-09-23, avant tout déploiement.
   *
   * 🔴 LA LISTE EST VOLONTAIREMENT PLUS COURTE QUE CE QUE LA CONFIGURATION DEMANDE. `business_management`,
   * `pages_show_list` et `pages_read_engagement` n'y sont PAS : elles peuvent servir à autre chose qu'aux
   * publicités dans la même application, et le seul moyen de le savoir serait de les retirer pour voir. On
   * retire ce qui est publicitaire SANS AMBIGUÏTÉ, et on laisse le reste vivre.
   *
   * ⚠️ CE CHEMIN N'EST PAS MESURÉ SUR UN JETON D'UTILISATEUR SYSTÈME, et le retrait par permission NOMMÉE
   * l'est encore moins que le retrait nu : la documentation de Meta décrit les deux pour un jeton
   * d'UTILISATEUR. On ne sait donc pas si ce qui reste peut encore servir en publicité, et on ne l'écrit
   * pas comme si on le savait (règle de 0129 : une justification fausse est pire qu'aucune). La première
   * déconnexion réelle tranchera, et son résultat vit dans le journal d'audit.
   */
  async revoquerAcces(jeton: string): Promise<void> {
    // ⚠️ TOUTES SONT TENTÉES, MÊME APRÈS UN REFUS. S'arrêter au premier échec laisserait les suivantes en
    // place alors qu'elles étaient peut-être retirables : on retire tout ce qu'on peut, et on dit ce qui
    // a résisté, plutôt que de rendre un échec global qui ne distingue pas « rien » de « presque tout ».
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

/** `act_123` et `123` désignent le même compte : on garde la forme nue, et les appels remettent le préfixe. */
export function sansPrefixeAct(id: string): string {
  return id.startsWith('act_') ? id.slice(4) : id;
}
