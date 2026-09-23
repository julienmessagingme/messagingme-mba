import { z } from 'zod';
import { ClientGraph } from './graph';
import { sansPrefixeAct } from './pubs';
import { STATUT_ACTIF, STATUT_PAUSE } from './pubs-payloads';

/**
 * CE QUI PARLE À L'API MARKETING DE META POUR CRÉER, PUBLIER ET METTRE EN PAUSE UNE PUBLICITÉ (lot 3,
 * commit 2, spec § 3.2). Les charges utiles, elles, sont PURES et vivent dans `./pubs-payloads.ts` : ici, il
 * n'y a que des appels.
 *
 * 🔴 UNE CLASSE À PART DE `MetaPubsClient`, et ce n'est pas de la cosmétique. Celui-là sert l'écran de
 * connexion : il LIT (des comptes, des Pages, un état). Celui-ci ÉCRIT sur le compte publicitaire d'un
 * client, donc il dépense son argent. Les tenir séparés fait qu'on ne se trompe pas de client en câblant, et
 * qu'une route de lecture ne peut pas, par accident, avoir sous la main de quoi créer une campagne.
 *
 * 🔴 TOUTE RÉPONSE PASSE PAR UN `safeParse`, jamais un `as`. Ici plus qu'ailleurs : ce qu'on lit est un
 * IDENTIFIANT qu'on garde pour toujours. Perdre celui de la campagne, c'est perdre le seul moyen de la
 * mettre en pause, donc d'arrêter une dépense.
 */

/** Toutes les créations de Graph rendent la même chose : un identifiant. Rien d'autre n'est supposé. */
const idSchema = z.object({ id: z.string().min(1) });

/**
 * `POST /act_X/adimages` rend un dictionnaire dont les CLÉS sont les noms de fichier. On ne sait donc pas
 * d'avance sous quelle clé lire : `z.record` prend la forme telle quelle, et l'appelant prend la première
 * entrée qui porte une empreinte.
 */
const imagesSchema = z.object({
  images: z.record(z.string(), z.object({ hash: z.string().min(1) })).optional(),
});

/** `GET /{page-id}?fields=access_token` : le jeton de PAGE dérivé du jeton du client. Jamais stocké. */
const jetonPageSchema = z.object({ access_token: z.string().min(1) });

/**
 * Les types de fichier qu'on accepte pour le visuel, et c'est une garde de SÉCURITÉ, pas de confort :
 * ce qui part d'ici va chez un tiers, sous l'identité du client.
 */
export const TYPES_VISUEL_PUB = ['image/jpeg', 'image/png'] as const;

/**
 * Plafond de taille du visuel d'une PUBLICITÉ, en octets.
 *
 * 🔴 LE NOM EST LONG EXPRÈS. Le dépôt porte DÉJÀ trois `TAILLE_IMAGE_MAX`, avec DEUX valeurs
 * différentes (5 Mo pour une pièce jointe d'agent, 2 Mo pour une image RCS). En ajouter un quatrième sous
 * le même nom ferait quatre vérités dont personne ne saurait laquelle s'applique à quoi, et un import
 * pris dans le mauvais module changerait une borne sans qu'aucun type ne bronche.
 *
 * ⚠️ Il est VOLONTAIREMENT bas devant ce que Meta accepte (30 Mo). Une publicité se regarde sur un téléphone :
 * au-delà de quelques mégaoctets, on n'achète pas de qualité, on achète un téléversement lent sur le chemin
 * d'une route HTTP que l'utilisateur attend.
 */
export const TAILLE_VISUEL_PUB_MAX = 5 * 1024 * 1024;

export class MetaPubsCreationClient extends ClientGraph {
  /** L'adresse d'un objet du compte publicitaire, avec son préfixe `act_` remis. */
  private urlCompte(comptePubId: string, chemin: string): string {
    return `${this.baseUrl}/${this.version}/act_${encodeURIComponent(sansPrefixeAct(comptePubId))}/${chemin}`;
  }

  /** `POST` en JSON, avec le jeton en en-tête. Le jeton ne voyage JAMAIS dans l'URL : elle est journalisée. */
  private async poster(url: string, jeton: string, corps: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.call(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jeton}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(corps),
    });
  }

  /** Lit l'identifiant d'une réponse de création. Lève si Meta n'en a pas rendu : on ne devine pas un id. */
  private static idDe(brut: Record<string, unknown>, quoi: string): string {
    const lu = idSchema.safeParse(brut);
    if (!lu.success) throw new Error(`Meta n’a pas rendu d’identifiant pour ${quoi}`);
    return lu.data.id;
  }

  /**
   * TÉLÉVERSE LE VISUEL et rend son empreinte (`image_hash`), que la créa citera.
   *
   * ⚠️ FORMULAIRE ET PAS JSON : `adimages` attend `bytes` en base64 dans un corps encodé en formulaire. Et
   * l'image ne part pas telle quelle dans l'URL, évidemment : elle peut peser des mégaoctets.
   */
  async televerserImage(comptePubId: string, jeton: string, base64: string): Promise<string> {
    const corps = new URLSearchParams({ bytes: base64 });
    const brut = await this.call(this.urlCompte(comptePubId, 'adimages'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${jeton}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: corps.toString(),
    });
    const lu = imagesSchema.safeParse(brut);
    const premiere = Object.values(lu.success ? lu.data.images ?? {} : {})[0];
    if (premiere === undefined) throw new Error('Meta n’a pas rendu d’empreinte pour ce visuel');
    return premiere.hash;
  }

  async creerCampagne(comptePubId: string, jeton: string, p: Record<string, unknown>): Promise<string> {
    return MetaPubsCreationClient.idDe(await this.poster(this.urlCompte(comptePubId, 'campaigns'), jeton, p), 'la campagne');
  }

  async creerEnsemble(comptePubId: string, jeton: string, p: Record<string, unknown>): Promise<string> {
    return MetaPubsCreationClient.idDe(await this.poster(this.urlCompte(comptePubId, 'adsets'), jeton, p), 'l’ensemble de publicités');
  }

  async creerCrea(comptePubId: string, jeton: string, p: Record<string, unknown>): Promise<string> {
    return MetaPubsCreationClient.idDe(await this.poster(this.urlCompte(comptePubId, 'adcreatives'), jeton, p), 'le visuel');
  }

  async creerPub(comptePubId: string, jeton: string, p: Record<string, unknown>): Promise<string> {
    return MetaPubsCreationClient.idDe(await this.poster(this.urlCompte(comptePubId, 'ads'), jeton, p), 'la publicité');
  }

  /**
   * SUPPRIME LA CAMPAGNE, ce qui emporte ce qu'elle contient.
   *
   * 🔴 C'EST LE RATTRAPAGE D'UNE CRÉATION À MOITIÉ FAITE, et il n'a qu'un seul appel à faire parce que Meta
   * supprime en cascade. Le faire objet par objet multiplierait les façons d'échouer au moment précis où
   * l'on essaie de réparer.
   */
  async supprimerCampagne(campagneId: string, jeton: string): Promise<void> {
    await this.call(`${this.baseUrl}/${this.version}/${encodeURIComponent(campagneId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${jeton}` },
    });
  }

  /** Allume ou éteint un objet (campagne, ensemble, publicité) : `POST /{id}` avec son statut. */
  async changerStatut(objetId: string, jeton: string, statut: typeof STATUT_ACTIF | typeof STATUT_PAUSE): Promise<void> {
    await this.poster(`${this.baseUrl}/${this.version}/${encodeURIComponent(objetId)}`, jeton, { status: statut });
  }

  /**
   * LE JETON DE PAGE, dérivé du jeton du client, JAMAIS STOCKÉ.
   *
   * 🔴 LA DOCUMENTATION DE META L'EXIGE POUR CE GUIDE, et elle est explicite : « Un token d'accès de Page
   * demandé par un·e utilisateur·ice autorisé·e à effectuer la tâche ADVERTISE sur la Page » (relu en ligne
   * le 2026-09-23). La créa est l'appel qui agit sur la Page, c'est donc elle qui le reçoit.
   *
   * ⚠️ **NON MESURÉ, ET ÇA SE DIT.** On ne sait pas encore si Meta refuse VRAIMENT la créa avec le jeton
   * d'utilisateur système, ni si le jeton de Page suffit aux appels de compte publicitaire. La première
   * création réelle du pilote tranche. En attendant, rendre `null` plutôt que lever est délibéré :
   * l'appelant retombe sur le jeton du client, et si Meta refuse, son message s'affiche tel quel.
   */
  async jetonDePage(pageId: string, jeton: string): Promise<string | null> {
    try {
      const brut = await this.call(`${this.baseUrl}/${this.version}/${encodeURIComponent(pageId)}?fields=access_token`, {
        headers: { Authorization: `Bearer ${jeton}` },
      });
      const lu = jetonPageSchema.safeParse(brut);
      return lu.success ? lu.data.access_token : null;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`jeton de Page ${pageId} non dérivé, on garde le jeton du client :`, err instanceof Error ? err.message : err);
      return null;
    }
  }
}
