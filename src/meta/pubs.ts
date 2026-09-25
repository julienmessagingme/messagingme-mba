import { z } from 'zod';
import { ClientGraph } from './graph';
import { messageDe } from '../lib/erreur';

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

/**
 * CE QUI EMPÊCHE, OU NON, DE DIFFUSER. Lu EN DIRECT à l'ouverture de l'écran, jamais mémorisé : un
 * indicateur de disponibilité qui date ne sert à rien, et une carte qui expire ne prévient personne.
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

/** Ce que le jeton du client accorde, LU AUX POINTS D'ENTRÉE DÉDIÉS (cf. `actifsAccordes`). */
export interface ActifsAccordes {
  comptesPub: ComptePubAccorde[];
  pages: PageAccordee[];
}

/**
 * La Page est-elle liée au compte WhatsApp de l'espace ?
 *
 * 🔴 PLUS AUCUN CODE NE CALCULE CE VERDICT, ET IL VAUT `inconnu` PARTOUT. Mesuré le 2026-09-23 sur le
 * compte réel, après avoir vérifié dans le WhatsApp Manager que la Page ÉTAIT bien liée au numéro : DIX
 * champs essayés sur les trois objets concernés. Sur le numéro, `connected_pages`, `linked_pages`,
 * `facebook_page`, `page`, `connected_page` n'existent pas. Sur la Page,
 * `connected_whatsapp_business_account` n'existe pas et `whatsapp_number` revient VIDE (il ne parle que
 * de l'ancienne connexion « WhatsApp Business app »). Meta affiche la liaison dans son interface et ne
 * l'expose par aucune API que nous puissions appeler. L'appel était donc condamné à un 400 à chaque
 * choix : il a été retiré, et l'écran emmène le client là où Meta l'affiche.
 *
 * ⚠️ LE TYPE ET LA COLONNE RESTENT, à TROIS VALEURS, pour le jour où Meta exposera cette liaison :
 * c'est ici qu'elle reviendra. Et la troisième valeur restera la plus importante, parce que « Meta ne
 * sait pas répondre » n'est pas « la Page n'est pas liée » : afficher « non liée » sur une ignorance
 * enverrait un client refaire une liaison qui existe déjà. `inconnu` se dit, il ne se devine pas.
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
 * Les permissions QUE NOUS RETIRONS à la déconnexion, et elles seules : celles qui n'ont aucun usage
 * hors publicité dans cette application.
 */
const PERMISSIONS_PUB = ['ads_management', 'ads_read', 'pages_manage_ads'] as const;

/** `GET /me?fields=id` : l'entité qui porte le jeton. */
const identiteSchema = z.object({ id: z.string() });

/** `GET /{ad-id}?fields=campaign_id`. `campaign_id` optionnel : on ne suppose rien de la réponse. */
const campagneDeLaPubSchema = z.object({ campaign_id: z.string().optional() });

/**
 * PLAFOND DE DURÉE DE LA RÉSOLUTION D'UNE PUB, en millisecondes (spec § 3.3 : « un appel à Meta, 3 s
 * maximum »).
 *
 * 🔴 BIEN PLUS COURT QUE LE PLAFOND GRAPH ORDINAIRE, ET C'EST LE SEUL APPEL DU DÉPÔT DANS CE CAS. Les autres
 * appels Graph servent un écran : leur plafond de trente secondes ne borne qu'un appel perdu. Celui-ci est
 * sur le CHEMIN CHAUD D'UN MESSAGE ENTRANT, derrière lequel attendent l'inbox, les scénarios et la réponse
 * au client. Trente secondes d'attente y seraient trente secondes de silence pour un vrai contact, et pour
 * TOUS les autres messages du même lot que Meta nous a envoyé.
 *
 * ⚠️ DÉPASSER LE DÉLAI N'EST PAS UNE PANNE : la campagne reste inconnue, le lead suit le chemin ordinaire, et
 * la résolution sera retentée au prochain lead de la même pub. On échange une information contre le temps de
 * réponse, délibérément.
 */
export const DELAI_RESOLUTION_PUB_MS = 3000;

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
   * L'état du compte publicitaire : peut-il diffuser aujourd'hui ?
   *
   * ⚠️ TROIS CHAMPS, ET LE TROISIÈME EST CELUI QU'ON CHERCHAIT. `funding_source_details` dit qu'un moyen
   * de paiement est rattaché ; sans lui, une pub se crée mais ne part jamais, et l'erreur arrive tard.
   * Mesuré le 2026-09-23 : ces trois champs se lisent avec la tâche ADVERTISE, sans `MANAGE`.
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
   * LA CAMPAGNE D'UNE PUBLICITÉ (`GET /{ad-id}?fields=campaign_id`). `null` = Meta n'a pas répondu, a refusé,
   * ou a dépassé les trois secondes.
   *
   * 🔴 C'EST CE QUI RELIE LES COPIES FAITES DANS LE GESTIONNAIRE (spec § 3.3). Le webhook ne porte que
   * l'identifiant de la PUB ; le lien, lui, est par CAMPAGNE. Une pub dupliquée porte un identifiant neuf et
   * la même campagne : un seul appel, mémorisé pour toujours (`pubs_connues`), et la copie route comme
   * l'originale. Sans lui, chaque duplicata perdrait son scénario en silence.
   *
   * ⚠️ ELLE NE LÈVE JAMAIS, contrairement au reste de ce client. Son appelant est le chemin d'un message
   * entrant : un refus de Meta ne doit pas devenir une exception qui traverse le routage d'un lot entier de
   * messages. Le refus est journalisé ici, une fois, avec ce qu'il faut pour le comprendre.
   *
   * ⚠️ LE MESSAGE D'UN ABANDON ANNONCERA LE PLAFOND GRAPH ORDINAIRE, pas celui-ci : `ClientGraph.call` ne
   * connaît que sa propre constante quand il traduit un abandon. Le journal ci-dessous dit donc le vrai
   * délai, pour que personne ne cherche une panne de trente secondes qui n'a pas eu lieu.
   */
  async campagneDeLaPub(adId: string, jeton: string): Promise<string | null> {
    try {
      const brut = await this.call(`${this.baseUrl}/${this.version}/${encodeURIComponent(adId)}?fields=campaign_id`, {
        headers: { Authorization: `Bearer ${jeton}` },
        signal: AbortSignal.timeout(DELAI_RESOLUTION_PUB_MS),
      });
      const lu = campagneDeLaPubSchema.safeParse(brut);
      return lu.success ? lu.data.campaign_id ?? null : null;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`campagne de la publicité ${adId} non résolue (plafond ${DELAI_RESOLUTION_PUB_MS} ms) :`, messageDe(err));
      return null;
    }
  }

  /**
   * QUI PORTE CE JETON, chez Meta (`GET /me`). Rend `null` si Meta ne répond pas.
   *
   * 🔴 CE N'EST PAS UNE COMMODITÉ, C'EST CE QUI REND `revoquerAcces` SÛR SUR UN REMPLACEMENT.
   * `DELETE /me/permissions/<perm>` porte sur le couple (application, ENTITÉ), pas sur LE jeton :
   * deux jetons du même utilisateur système sous la même application désignent la MÊME entité, donc
   * révoquer avec l'un retire les permissions de l'autre. Comparer les identités AVANT de révoquer
   * transforme cette hypothèse en mesure, au moment où elle compte.
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
   * ⚠️ **MESURÉ SUR UN JETON D'UTILISATEUR SYSTÈME LE 2026-09-23**, et ce commentaire disait le contraire
   * jusque-là (« ce chemin n'est pas mesuré », écrit avant la première déconnexion réelle). Les trois
   * permissions ont été retirées du jeton de Gerermonchantier avant de déposer celui de notre propre
   * compte : **HTTP 200 sur les trois**. Le retrait par permission NOMMÉE fonctionne donc sur ce type de
   * jeton, là où la documentation de Meta ne décrit que le cas d'un jeton d'UTILISATEUR.
   *
   * ⚠️ CE QUI RESTE INCONNU, et qu'on n'écrit donc pas comme su : si les trois permissions laissées en
   * place (`business_management`, `pages_show_list`, `pages_read_engagement`) permettent encore quoi que
   * ce soit en publicité. Le seul moyen de le savoir serait de les retirer pour voir, sur un jeton qui
   * fait AUSSI parler un numéro WhatsApp.
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

/** Ce qui est arrivé à l'ancien jeton d'un remplacement. Le détail de chaque valeur : `src/http/ops.ts`. */
export type SortAncienAcces = 'aucun' | 'retire' | 'meme_entite' | 'indetermine' | 'echec';

/** Ce que `retirerAncienAcces` a besoin de savoir faire. Un objet minuscule, pour qu'un faux tienne en trois lignes. */
export interface ClientRetrait {
  identite(jeton: string): Promise<string | null>;
  revoquerAcces(jeton: string): Promise<void>;
}

/**
 * RETIRER LES PERMISSIONS DE L'ANCIEN JETON, quand un dépôt en remplace un, ET SEULEMENT SI C'EST SÛR.
 *
 * 🔴 CE QU'ELLE ÉVITE. `DELETE /me/permissions/<perm>` porte sur le couple (application, ENTITÉ), pas
 * sur LE jeton : deux jetons du même utilisateur système sous la même application se révoquent ENSEMBLE.
 * Or c'est l'usage normal du dépôt. Retirer l'ancien désarmerait donc le neuf, qu'on vient de vérifier,
 * et la route répondrait 200 sur une connexion morte.
 *
 * 🔴 POURQUOI C'EST UNE FONCTION, ET PAS UN `if` DANS LE CÂBLAGE. La décision a vécu dans un `if`, et
 * la seule chose qui la gardait était un test qui lisait le TEXTE de ce `if`. Deux relectures à froid
 * l'ont mesuré : une première écriture laissait passer la condition NIÉE, une seconde laissait passer
 * le `!` RETIRÉ et les corps ÉCHANGÉS, c'est-à-dire le bug d'origine sous trois orthographes. **Un test
 * de source ne sait pas juger une sémantique.** Ici le chemin entier s'exécute contre un faux client, et
 * chacune de ces mutations fait tomber un cas.
 *
 * ⚠️ `null` VAUT REFUS DES DEUX CÔTÉS : une identité que Meta n'a pas rendue ne PROUVE pas une
 * différence, et un doute ne justifie pas de casser ce qui marche.
 *
 * ⚠️ UN ÉCHEC DE RETRAIT N'ARRÊTE PAS L'APPELANT : un ancien jeton déjà mort ne doit pas retenir
 * l'exploitation. Mais on ne fait pas passer un refus pour un succès, d'où `echec`.
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
