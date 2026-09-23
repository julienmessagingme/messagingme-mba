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

/** Ce que le jeton du client accorde, lu dans le jeton lui-même. */
export interface ActifsAccordes {
  /** Identifiants de comptes publicitaires, SANS le préfixe `act_` (les appels l'ajoutent). */
  comptesPub: string[];
  pages: string[];
}

export interface InfosComptePub {
  nom: string | null;
  devise: string | null;
  fuseau: string | null;
}

/**
 * La Page est-elle liée au compte WhatsApp de l'espace ?
 *
 * 🔴 TROIS VALEURS, ET LA TROISIÈME EST LA PLUS IMPORTANTE. « Meta ne sait pas répondre » n'est pas « la
 * Page n'est pas liée ». Afficher « non liée » sur une ignorance enverrait un client refaire une liaison
 * qui existe déjà, et lui ferait douter d'un écran qui a tort. `inconnu` se dit, il ne se devine pas.
 */
export type LiaisonPage = 'oui' | 'non' | 'inconnu';

/** Le compte publicitaire, tel que Graph le rend. Tous les champs sont optionnels : on ne suppose rien. */
const compteSchema = z.object({
  name: z.string().optional(),
  currency: z.string().optional(),
  timezone_name: z.string().optional(),
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
   * Les comptes publicitaires et les Pages que le jeton accorde, lus dans `debug_token`.
   *
   * ⚠️ DEUX SCOPES, DEUX LISTES, et aucune des deux n'est une erreur quand elle est vide : un client peut
   * avoir accordé une Page sans compte publicitaire. C'est la route qui traduit cela en « connexion
   * incomplète », parce qu'elle seule sait ce que l'écran doit dire.
   */
  async actifsAccordes(jeton: string): Promise<ActifsAccordes> {
    const comptes = await this.ciblesDuJeton(jeton, ['ads_management', 'ads_read']);
    const pages = await this.ciblesDuJeton(jeton, ['pages_show_list', 'pages_manage_ads']);
    return { comptesPub: comptes.map(sansPrefixeAct), pages };
  }

  /** Nom, devise et fuseau du compte publicitaire. Ils décident de la monnaie et des heures affichées. */
  async infosCompte(comptePubId: string, jeton: string): Promise<InfosComptePub> {
    const qs = new URLSearchParams({ fields: 'name,currency,timezone_name' });
    const brut = await this.call(
      `${this.baseUrl}/${this.version}/act_${encodeURIComponent(sansPrefixeAct(comptePubId))}?${qs.toString()}`,
      { headers: { Authorization: `Bearer ${jeton}` } },
    );
    const lu = compteSchema.safeParse(brut);
    if (!lu.success) return { nom: null, devise: null, fuseau: null };
    return { nom: lu.data.name ?? null, devise: lu.data.currency ?? null, fuseau: lu.data.timezone_name ?? null };
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
   * ⚠️ Ce qui reste après ce retrait ne peut plus rien faire en publicité : c'est la porte qu'on avait
   * ouverte, et c'est celle-là qu'on referme. L'appelant traite un échec comme une information à DIRE.
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
