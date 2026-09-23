import { z } from 'zod';
import { ClientGraph } from './graph';
import { sansPrefixeAct } from './pubs';
import { STATUT_ACTIF, STATUT_PAUSE } from './pubs-payloads';

/**
 * CE QUI PARLE À L'API MARKETING DE META POUR PILOTER UNE PUBLICITÉ : la créer, la publier, la mettre en
 * pause, et relire ce qu'elle devient (lot 3, spec § 3.2 et § 3.5). Les charges utiles, elles, sont PURES et
 * vivent dans `./pubs-payloads.ts` : ici, il n'y a que des appels.
 *
 * 🔴 UNE CLASSE À PART DE `MetaPubsClient`, et ce n'est pas de la cosmétique. Celui-là sert l'écran de
 * CONNEXION : quels comptes, quelles Pages, ce compte peut-il diffuser. Celui-ci PILOTE les publicités d'un
 * client, donc il dépense son argent. Les tenir séparés fait qu'on ne se trompe pas de client en câblant, et
 * qu'une route de connexion ne peut pas, par accident, avoir sous la main de quoi créer une campagne.
 *
 * ⚠️ LE SUIVI (deux lectures) EST ICI ET PAS AVEC LA CONNEXION, parce qu'il parle des MÊMES objets que la
 * création, avec le même jeton et les mêmes identifiants. Le séparer ferait une troisième classe dont la
 * seule différence serait le verbe HTTP.
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
 * Combien d'identifiants dans un seul `GET /?ids=`.
 *
 * ⚠️ Meta ne documente pas précisément sa limite. Cinquante est très en deçà de ce qu'on lui voit accepter,
 * et le dépassement ne rendrait pas une réponse partielle : il rendrait une ERREUR, donc zéro suivi pour
 * TOUTES les campagnes du paquet. Un plafond prudent coûte un appel de plus, un plafond optimiste coûte le
 * suivi entier d'un client.
 */
const IDS_PAR_APPEL = 50;

/** Ce que le suivi lit d'une campagne chez Meta. */
export interface EtatCampagneMeta {
  /** `effective_status` tel quel : PENDING_REVIEW, ACTIVE, DISAPPROVED, WITH_ISSUES, CAMPAIGN_PAUSED... */
  statut: string | null;
  motifRefus: string | null;
  debut: string | null;
  fin: string | null;
}

/** La dépense et les clics d'une campagne, depuis le début. */
export interface DepensePub {
  depense: number | null;
  clics: number | null;
}

/**
 * Tout est optionnel sauf rien : on ne suppose AUCUN champ. Un `effective_status` absent doit rendre
 * « je ne sais pas », jamais faire échouer le suivi de toutes les autres campagnes du même appel.
 */
const campagneSuivieSchema = z.object({
  effective_status: z.string().optional(),
  start_time: z.string().optional(),
  stop_time: z.string().optional(),
  issues_info: z.array(z.object({
    error_summary: z.string().optional(),
    error_message: z.string().optional(),
  })).optional(),
});
const lotCampagnesSchema = z.record(z.string(), campagneSuivieSchema);

const lotInsightsSchema = z.record(z.string(), z.object({
  insights: z.object({
    data: z.array(z.object({
      spend: z.string().optional(),
      inline_link_clicks: z.string().optional(),
    })).optional(),
  }).optional(),
}));

/** Découpe une liste en paquets. Fonction PURE, et la seule raison pour laquelle elle est nommée est qu'un
 *  découpage muet dans une boucle est l'endroit où l'on oublie le dernier paquet. */
function parPaquets<T>(liste: readonly T[], taille: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < liste.length; i += taille) out.push(liste.slice(i, i + taille));
  return out;
}

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
   * LE SUIVI : ce que les campagnes sont devenues chez Meta. DEUX appels pour TOUTES les campagnes d'un
   * compte, pas deux par campagne.
   *
   * 🔴 C'EST LA LECTURE PAR LOT (`GET /?ids=`) QUI REND LE BALAYAGE TENABLE. Un appel par campagne ferait,
   * pour un client à vingt publicités, quarante appels toutes les quinze minutes, soit cent soixante par
   * heure : le niveau d'accès « Limited » de l'API Marketing ne le supporterait pas, et le compte serait
   * bridé pour TOUT le reste, création comprise. Ici, c'est deux appels par compte et par passage, quel que
   * soit le nombre de publicités.
   *
   * ⚠️ PAR PAQUETS DE {@link IDS_PAR_APPEL}, parce que `?ids=` a une limite que Meta ne documente pas
   * précisément. Un paquet trop gros ne rendrait pas une réponse partielle : il rendrait une ERREUR, donc
   * zéro suivi pour tout le monde.
   */
  async lireCampagnes(campagneIds: readonly string[], jeton: string): Promise<Map<string, EtatCampagneMeta>> {
    const out = new Map<string, EtatCampagneMeta>();
    for (const paquet of parPaquets(campagneIds, IDS_PAR_APPEL)) {
      const qs = new URLSearchParams({
        ids: paquet.join(','),
        fields: 'id,name,effective_status,issues_info,lifetime_budget,start_time,stop_time',
      });
      const brut = await this.call(`${this.baseUrl}/${this.version}/?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${jeton}` },
      });
      const lu = lotCampagnesSchema.safeParse(brut);
      if (!lu.success) continue;
      for (const [id, c] of Object.entries(lu.data)) {
        out.set(id, {
          statut: c.effective_status ?? null,
          // ⚠️ ON PREND LE PREMIER MOTIF, pas tous : Meta en rend parfois plusieurs, et l'écran doit dire
          // UNE raison actionnable plutôt qu'une liste que personne ne lit. Le lien vers le Gestionnaire,
          // à côté, mène à la liste complète.
          motifRefus: c.issues_info?.[0]?.error_summary ?? c.issues_info?.[0]?.error_message ?? null,
          debut: c.start_time ?? null,
          fin: c.stop_time ?? null,
        });
      }
    }
    return out;
  }

  /**
   * LA DÉPENSE ET LES CLICS, par campagne, depuis le début.
   *
   * ⚠️ **LE CHAMP DES CLICS N'EST PAS MESURÉ, ET LA SPEC LE DIT** (§ 3.5) : « Les clics sont les clics sur le
   * lien vers WhatsApp. Le champ Insights est vérifié le premier jour du pilote contre le chiffre du
   * Gestionnaire. » On prend `inline_link_clicks`, qui est le compte des clics SUR LE LIEN, et non `clicks`,
   * qui compte tout clic sur la publicité (une réaction, un nom de Page, un déroulé de texte). Si le premier
   * jour montre un écart avec le Gestionnaire, c'est CE champ qu'on change, une fois.
   *
   * ⚠️ `date_preset=maximum` : depuis le début de la campagne. Meta fige la dépense après 28 jours, ce qui
   * est exactement ce qu'on veut d'un cumul.
   */
  async lireDepenses(campagneIds: readonly string[], jeton: string): Promise<Map<string, DepensePub>> {
    const out = new Map<string, DepensePub>();
    for (const paquet of parPaquets(campagneIds, IDS_PAR_APPEL)) {
      const qs = new URLSearchParams({
        ids: paquet.join(','),
        fields: 'insights.date_preset(maximum){spend,inline_link_clicks}',
      });
      const brut = await this.call(`${this.baseUrl}/${this.version}/?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${jeton}` },
      });
      const lu = lotInsightsSchema.safeParse(brut);
      if (!lu.success) continue;
      for (const [id, c] of Object.entries(lu.data)) {
        const ligne = c.insights?.data?.[0];
        // ⚠️ AUCUNE LIGNE N'EST UN CAS NORMAL, pas une panne : une campagne qui n'a encore rien diffusé n'a
        // aucune statistique. On laisse alors `null`, et l'écran dit « pas encore de diffusion » plutôt que
        // d'afficher une dépense de zéro qui ressemble à une mesure.
        if (ligne === undefined) continue;
        out.set(id, {
          // Meta rend la dépense en CHAÎNE, dans l'unité principale de la devise (des euros, pas des
          // centimes) : c'est l'inverse de ce qu'il attend en écriture pour un budget. Mesuré dans sa
          // documentation, et c'est exactement le genre d'asymétrie qui se paie si on la suppose.
          depense: ligne.spend === undefined ? null : Number(ligne.spend),
          clics: ligne.inline_link_clicks === undefined ? null : Number(ligne.inline_link_clicks),
        });
      }
    }
    return out;
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
