import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ClientGraph } from './graph';
import { sansPrefixeAct } from './pubs';
import { STATUT_ACTIF, STATUT_PAUSE } from './pubs-payloads';
import { messageDe } from '../lib/erreur';
import { fetchPublic } from '../lib/connexion-publique';
import { lireOctetsBornes } from '../lib/corps-borne';
import { typeImage } from '../rcs/image';

/**
 * Pilotage d'une publicité par l'API Marketing de Meta : la créer, la publier, la mettre en pause, et suivre ce
 * qu'elle devient. Les charges utiles, pures, vivent dans `./pubs-payloads.ts`.
 *
 * 🔴 Classe distincte de `MetaPubsClient` (l'écran de connexion) : celle-ci dépense l'argent du client, et une
 * route de connexion ne doit pas avoir sous la main de quoi créer une campagne. Toute réponse passe par un
 * `safeParse` : perdre l'identifiant d'une campagne, c'est perdre le moyen d'arrêter sa dépense.
 */

/** Toutes les créations de Graph rendent la même chose : un identifiant. Rien d'autre n'est supposé. */
const idSchema = z.object({ id: z.string().min(1) });

/**
 * `POST /act_X/adimages` rend un dictionnaire dont les clés sont les noms de fichier : `z.record` prend la forme
 * telle quelle, et l'appelant prend la première entrée qui porte une empreinte.
 */
const imagesSchema = z.object({
  images: z.record(z.string(), z.object({ hash: z.string().min(1) })).optional(),
});

/** `GET /{page-id}?fields=access_token` : le jeton de Page dérivé du jeton du client. Jamais stocké. */
const jetonPageSchema = z.object({ access_token: z.string().min(1) });

/**
 * Combien d'identifiants dans un seul `GET /?ids=`. Meta ne documente pas sa limite, et la dépasser rend une
 * erreur, pas une réponse partielle, donc zéro suivi pour tout le paquet : un plafond prudent coûte un appel de plus.
 */
const IDS_PAR_APPEL = 50;

/** Ce que le suivi lit d'une campagne chez Meta. */
export interface EtatCampagneMeta {
  /** `effective_status` tel quel : PENDING_REVIEW, ACTIVE, DISAPPROVED, WITH_ISSUES, CAMPAIGN_PAUSED... */
  statut: string | null;
  motifRefus: string | null;
  debut: string | null;
  fin: string | null;
  /**
   * Le budget total dans l'unité principale de la devise. Meta le rend en unités mineures : on reconvertit ici,
   * une fois (symétrie de `budgetEnUnitesMineures`), sans quoi 150 € s'afficheraient 15 000.
   */
  budgetTotal: number | null;
}

/** La dépense, les clics, les impressions et la couverture d'une campagne, depuis le début. */
export interface DepensePub {
  depense: number | null;
  clics: number | null;
  impressions: number | null;
  /** Les personnes distinctes touchées (`reach` chez Meta). */
  couverture: number | null;
}

/**
 * Aucun champ n'est supposé : un `effective_status` absent rend « je ne sais pas », sans faire échouer le suivi
 * des autres campagnes du même appel.
 */
const campagneSuivieSchema = z.object({
  effective_status: z.string().optional(),
  start_time: z.string().optional(),
  stop_time: z.string().optional(),
  // Le budget vit sur l'ensemble, expansé depuis la campagne. Meta rend les montants en chaîne, en unités
  // mineures (`"15000"` pour 150 €).
  adsets: z.object({
    data: z.array(z.object({ lifetime_budget: z.string().optional() })).optional(),
  }).optional(),
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
      impressions: z.string().optional(),
      reach: z.string().optional(),
    })).optional(),
  }).optional(),
}));

/**
 * Un montant de Meta, des unités mineures vers l'unité principale, ou `null`.
 * 🔴 `0` et le non fini valent `null` : le suivi écrit avec `coalesce($n, budget_total)`, donc une valeur non
 * nulle écrase le budget saisi par le client, et un `"0"` de Meta afficherait « budget 0 » sur une pub qui dépense.
 */
function montantMajeur(brut: string | undefined): number | null {
  const n = nombreFini(brut);
  return n !== null && n > 0 ? n / 100 : null;
}

/**
 * Un nombre rendu par Meta, ou `null`, jamais `NaN` : `depense` est un `numeric`, qui accepte `NaN` (l'écran
 * afficherait « NaN »), et `clics` un `integer`, qui le refuse (tout le balayage de suivi de l'espace tomberait).
 * Garantit le fini, pas l'entier : les comptes passent en plus par `entierOuRien`.
 * Zéro est une mesure valide ici, contrairement au budget.
 */
function nombreFini(brut: string | undefined): number | null {
  if (brut === undefined) return null;
  const n = Number(brut);
  return Number.isFinite(n) ? n : null;
}

/**
 * Un compte de Meta (clics, impressions, couverture), ou `null` s'il n'est pas entier : leurs colonnes sont
 * entières, et une valeur fractionnaire y ferait échouer l'écriture, donc tout le balayage de l'espace.
 */
function entierOuRien(brut: string | undefined): number | null {
  const n = nombreFini(brut);
  return n !== null && Number.isInteger(n) ? n : null;
}

/**
 * Un décalage d'octets du dépôt vidéo. Meta les rend en CHAÎNE dans ses exemples (`"start_offset": "0"`) ; on
 * accepte aussi un nombre, et rien d'autre : un décalage deviné enverrait le mauvais morceau du fichier.
 */
const decalageSchema = z.union([z.string().regex(/^\d{1,15}$/), z.number().int().nonnegative()]).transform(Number);

/** `upload_phase=start` : la session de dépôt, la vidéo qu'elle remplira, et le premier morceau attendu. */
const debutDepotSchema = z.object({
  upload_session_id: z.string().min(1),
  video_id: z.string().min(1),
  start_offset: decalageSchema,
  end_offset: decalageSchema,
});

/** `upload_phase=transfer` : le morceau SUIVANT attendu. Quand les deux décalages sont égaux, tout est reçu. */
const morceauSuivantSchema = z.object({ start_offset: decalageSchema, end_offset: decalageSchema });

/** `upload_phase=finish` : un succès explicite, ou rien. Un `false` n'est pas une fin de dépôt. */
const finDepotSchema = z.object({ success: z.literal(true) });

/** `GET /{video-id}?fields=status`. Tout est optionnel : un état absent se lit « pas prête », jamais « prête ». */
const etatVideoSchema = z.object({
  status: z.object({
    video_status: z.string().optional(),
    processing_progress: z.number().optional(),
  }).optional(),
});

/** `GET /{video-id}/thumbnails` : les images que Meta extrait de la vidéo, dont une « préférée ». */
const vignettesSchema = z.object({
  data: z.array(z.object({ uri: z.string().optional(), is_preferred: z.boolean().optional() })).optional(),
});

/** Une audience personnalisée telle que Meta la décrit. Lue UNE PAR UNE : une ligne étrange ne vide pas la liste. */
const audienceSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  subtype: z.string().optional(),
  approximate_count_lower_bound: z.number().optional(),
  approximate_count_upper_bound: z.number().optional(),
  delivery_status: z.object({ code: z.number().optional(), description: z.string().optional() }).optional(),
  operation_status: z.object({ code: z.number().optional(), description: z.string().optional() }).optional(),
});
/**
 * Une page de l'arête `customaudiences`. `paging.next` ne sert qu'à savoir s'il y a une suite : on ne SUIT jamais
 * cette adresse, rendue par un tiers, avec le jeton du client en en-tête ; la page suivante se redemande avec le
 * curseur `after`, sur notre propre adresse.
 */
const listeAudiencesSchema = z.object({
  data: z.array(z.unknown()).optional(),
  paging: z.object({
    next: z.string().optional(),
    cursors: z.object({ after: z.string().optional() }).optional(),
  }).optional(),
});

/** Les champs lus d'une audience, écrits une fois pour la liste et pour la vérification à la création. */
const CHAMPS_AUDIENCE = 'id,name,subtype,approximate_count_lower_bound,approximate_count_upper_bound,delivery_status,operation_status';

/**
 * Combien d'audiences on lit pour l'écran, en une page. Au-delà, l'écran dit que la liste est tronquée plutôt que
 * d'enchaîner des appels sur un compte dont l'accès à l'API Marketing est « Limited ».
 */
const AUDIENCES_PAR_PAGE = 200;

/**
 * Combien d'audiences un compte publicitaire peut porter chez Meta (possédées et partagées) : 500. La vérification
 * à la création lit donc au plus ce nombre, page par page, pour ne pas refuser une audience de la page 2.
 */
const AUDIENCES_MAX_COMPTE = 500;
const PAGES_AUDIENCES_MAX = Math.ceil(AUDIENCES_MAX_COMPTE / AUDIENCES_PAR_PAGE);

/**
 * Plafond de durée d'un morceau de vidéo relayé à Meta, bien au-dessus du plafond Graph ordinaire (30 s) : le
 * morceau arrive du navigateur EN FLUX, donc à la vitesse d'envoi du client, et Meta ne répond qu'une fois tout
 * reçu. Un plafond de 30 s couperait un morceau de quelques dizaines de mégaoctets sur une connexion ordinaire.
 * ⚠️ Il ne vaut QUE pour ce relais : partout ailleurs, cinq minutes dépasseraient les 100 s au bout desquelles
 * Cloudflare coupe la requête du navigateur.
 */
export const DELAI_MORCEAU_VIDEO_MS = 5 * 60_000;

/**
 * Plafond du rapatriement de la vignette d'une vidéo : le plafond Graph ordinaire, pas celui d'un morceau. Cet
 * appel est sur le chemin de la CRÉATION, que Cloudflare coupe à 100 s : un CDN qui traîne doit échouer lisiblement
 * pendant que le navigateur attend encore, pas après.
 */
export const DELAI_VIGNETTE_MS = 30_000;

/**
 * 🔴 L'HÔTE DU DÉPÔT D'UNE VIDÉO (`/act_{id}/advideos`, ses trois phases), ÉCRIT ICI ET NULLE PART AILLEURS.
 * Point que l'essai réel tranche, parce que les deux sources de Meta se contredisent :
 *  - la documentation de la Video API (page « Overview », relue le 2026-09-28) dit que l'hôte
 *    `graph-video.facebook.com` est DÉPRÉCIÉ pour le dépôt de vidéos, et qu'il faut passer par `graph.facebook.com` ;
 *  - le SDK officiel (`facebook-python-business-sdk`, `video_uploader.py`, branche `main`) force encore
 *    `https://graph-video.facebook.com` sur les trois phases d'`advideos`.
 * On suit la documentation. Si le premier dépôt réel échoue sur cet hôte (refus, ou morceau qui n'aboutit pas),
 * c'est cette constante, seule, qui passe à `https://graph-video.facebook.com`.
 */
export const HOTE_DEPOT_VIDEO = 'https://graph.facebook.com';

/** Ce qu'on sait de l'état d'une vidéo chez Meta. `traitement` couvre tout ce qui n'est ni prêt ni en erreur. */
export interface EtatVideo {
  etat: 'prete' | 'traitement' | 'erreur';
  /** `processing_progress`, de 0 à 100, quand Meta le rend. */
  progression: number | null;
}

/** Une session de dépôt ouverte, et le morceau que Meta attend (de `debut` inclus à `fin` exclu). */
export interface DepotVideo {
  videoId: string;
  sessionId: string;
  debut: number;
  fin: number;
}

/** Une audience personnalisée du compte publicitaire, telle que l'écran la présente. */
export interface AudiencePub {
  id: string;
  nom: string | null;
  sousType: string | null;
  /** Taille approximative : `null` quand Meta ne la donne pas (audience trop petite, ou encore en calcul). */
  tailleMin: number | null;
  tailleMax: number | null;
  /** `delivery_status.code === 200` : la seule audience qu'on laisse cibler. */
  utilisable: boolean;
  /** Pourquoi elle ne l'est pas, dans les mots de Meta, quand il les donne. */
  raison: string | null;
}

export interface ListeAudiencesPub {
  audiences: AudiencePub[];
  /** Meta avait une page de plus : l'écran le dit au lieu de laisser croire que la liste est complète. */
  tronquee: boolean;
}

/** D'une ligne brute de Meta à une audience, ou `null` si la ligne n'a pas la forme attendue. */
function versAudience(brut: unknown): AudiencePub | null {
  const lu = audienceSchema.safeParse(brut);
  if (!lu.success) return null;
  const a = lu.data;
  const utilisable = a.delivery_status?.code === 200;
  // Meta rend -1 quand il ne donne pas de taille : ce n'est pas une taille.
  const taille = (n: number | undefined): number | null => (n !== undefined && Number.isFinite(n) && n >= 0 ? n : null);
  return {
    id: a.id,
    nom: a.name ?? null,
    sousType: a.subtype ?? null,
    tailleMin: taille(a.approximate_count_lower_bound),
    tailleMax: taille(a.approximate_count_upper_bound),
    utilisable,
    raison: utilisable ? null : a.delivery_status?.description ?? a.operation_status?.description ?? null,
  };
}

/**
 * Le corps `multipart/form-data` d'un morceau de vidéo, construit EN FLUX : les champs, puis les octets du morceau
 * tels qu'ils arrivent, puis la fin. 🔴 Rien n'est tamponné : `FormData` exige un `Blob`, donc le morceau entier en
 * mémoire, ce que cette route existe pour éviter. La longueur totale est connue d'avance (le morceau est borné par
 * ses décalages), et elle part en `Content-Length` : `fetch` refuse alors d'envoyer un corps qui n'y correspond pas.
 */
function corpsMorceau(
  champs: Readonly<Record<string, string>>,
  octets: AsyncIterable<Uint8Array>,
  taille: number,
): { corps: ReadableStream<Uint8Array>; longueur: number; type: string } {
  const frontiere = `----engageme${randomBytes(12).toString('hex')}`;
  const enc = new TextEncoder();
  const avant = enc.encode(
    Object.entries(champs)
      .map(([k, v]) => `--${frontiere}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
      .join('')
    + `--${frontiere}\r\nContent-Disposition: form-data; name="video_file_chunk"; filename="morceau"\r\n`
    + 'Content-Type: application/octet-stream\r\n\r\n',
  );
  const apres = enc.encode(`\r\n--${frontiere}--\r\n`);
  const source = octets[Symbol.asyncIterator]();
  let phase: 'avant' | 'octets' | 'fini' = 'avant';
  const corps = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (phase === 'avant') { c.enqueue(avant); phase = 'octets'; return; }
      if (phase === 'octets') {
        const r = await source.next();
        if (!r.done) { c.enqueue(r.value); return; }
        c.enqueue(apres);
        phase = 'fini';
        return;
      }
      c.close();
    },
    async cancel(raison) { await source.return?.(raison); },
  });
  return { corps, longueur: avant.byteLength + taille + apres.byteLength, type: `multipart/form-data; boundary=${frontiere}` };
}

/** Découpe une liste en paquets. Fonction pure, nommée pour qu'on n'oublie pas le dernier paquet. */
function parPaquets<T>(liste: readonly T[], taille: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < liste.length; i += taille) out.push(liste.slice(i, i + taille));
  return out;
}

/**
 * Types de fichier acceptés pour le visuel : une garde de sécurité, ce qui part d'ici va chez un tiers sous
 * l'identité du client.
 */
export const TYPES_VISUEL_PUB = ['image/jpeg', 'image/png'] as const;

/**
 * Plafond de taille du visuel d'une publicité, en octets. Nom long exprès : le dépôt porte déjà plusieurs
 * `TAILLE_IMAGE_MAX` aux valeurs différentes. Bas devant ce que Meta accepte (30 Mo) : au-delà de quelques
 * mégaoctets, on n'achète qu'un téléversement lent sur une route HTTP que l'utilisateur attend.
 */
export const TAILLE_VISUEL_PUB_MAX = 5 * 1024 * 1024;

export class MetaPubsCreationClient extends ClientGraph {
  /**
   * `telecharger` sert à UNE chose : rapatrier la vignette d'une vidéo depuis l'adresse que Meta rend. Cette adresse
   * n'est pas un hôte fixe, d'où `fetchPublic` (qui refuse une adresse interne à la connexion) plutôt que `fetch` ;
   * injectable pour qu'un test n'ouvre aucune connexion.
   */
  constructor(
    appId: string,
    appSecret: string,
    version: string,
    baseUrl?: string,
    private readonly telecharger: typeof fetch = fetchPublic,
  ) {
    super(appId, appSecret, version, baseUrl);
  }

  /** L'adresse d'un objet du compte publicitaire, avec son préfixe `act_` remis. */
  private urlCompte(comptePubId: string, chemin: string, hote: string = this.baseUrl): string {
    return `${hote}/${this.version}/act_${encodeURIComponent(sansPrefixeAct(comptePubId))}/${chemin}`;
  }

  /** L'adresse du dépôt vidéo, pour ses trois phases : le seul appel qui passe par {@link HOTE_DEPOT_VIDEO}. */
  private urlDepotVideo(comptePubId: string): string {
    return this.urlCompte(comptePubId, 'advideos', HOTE_DEPOT_VIDEO);
  }

  /** `POST` en JSON, jeton en en-tête : jamais dans l'URL, qui est journalisée. */
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
   * Téléverse le visuel et rend son empreinte (`image_hash`), que la créa citera. Formulaire et non JSON :
   * `adimages` attend `bytes` en base64 dans un corps encodé en formulaire.
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

  /** `POST` d'un formulaire encodé (`upload_phase`) : les deux phases du dépôt vidéo qui ne portent pas d'octets. */
  private async posterFormulaire(url: string, jeton: string, champs: Record<string, string>): Promise<Record<string, unknown>> {
    return this.call(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jeton}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(champs).toString(),
    });
  }

  /**
   * Ouvre le dépôt d'une vidéo (`upload_phase=start`) : Meta rend la session, l'identifiant de la vidéo, et le
   * premier morceau qu'il attend. Rien de facturable : une vidéo sans publicité ne coûte rien.
   * ⚠️ La taille des morceaux est décidée par Meta et n'est pas documentée : on relaie ce qu'il demande, sans
   * supposer de valeur.
   */
  async demarrerDepotVideo(comptePubId: string, jeton: string, taille: number): Promise<DepotVideo> {
    const brut = await this.posterFormulaire(this.urlDepotVideo(comptePubId), jeton, {
      upload_phase: 'start', file_size: String(taille),
    });
    const lu = debutDepotSchema.safeParse(brut);
    if (!lu.success) throw new Error('Meta n’a pas ouvert de session de dépôt pour cette vidéo');
    return {
      videoId: lu.data.video_id, sessionId: lu.data.upload_session_id,
      debut: lu.data.start_offset, fin: lu.data.end_offset,
    };
  }

  /**
   * Relaie UN morceau (`upload_phase=transfer`) : les octets arrivent en flux et repartent en flux, sans être
   * tamponnés (voir `corpsMorceau`). Rend le morceau suivant attendu ; des décalages égaux veulent dire « tout est
   * reçu ». `taille` est la longueur exacte du morceau : un flux qui en porte plus ou moins fait échouer l'envoi.
   */
  async transfererMorceauVideo(
    comptePubId: string,
    jeton: string,
    m: { sessionId: string; debut: number; taille: number; octets: AsyncIterable<Uint8Array> },
  ): Promise<{ debut: number; fin: number }> {
    const { corps, longueur, type } = corpsMorceau(
      { upload_phase: 'transfer', upload_session_id: m.sessionId, start_offset: String(m.debut) },
      m.octets,
      m.taille,
    );
    // `duplex: 'half'` : exigé par `fetch` pour un corps en flux. Absent du type `RequestInit` du DOM.
    const init: Omit<RequestInit, 'signal'> & { duplex: 'half' } = {
      method: 'POST',
      headers: { Authorization: `Bearer ${jeton}`, 'Content-Type': type, 'Content-Length': String(longueur) },
      body: corps,
      duplex: 'half',
    };
    const lu = morceauSuivantSchema.safeParse(await this.call(this.urlDepotVideo(comptePubId), init, DELAI_MORCEAU_VIDEO_MS));
    if (!lu.success) throw new Error('Meta n’a pas dit quel morceau de la vidéo envoyer ensuite');
    return { debut: lu.data.start_offset, fin: lu.data.end_offset };
  }

  /** Clôt le dépôt (`upload_phase=finish`) : Meta commence alors son traitement, asynchrone. */
  async terminerDepotVideo(comptePubId: string, jeton: string, sessionId: string): Promise<void> {
    const brut = await this.posterFormulaire(this.urlDepotVideo(comptePubId), jeton, {
      upload_phase: 'finish', upload_session_id: sessionId,
    });
    if (!finDepotSchema.safeParse(brut).success) throw new Error('Meta n’a pas confirmé la fin du dépôt de la vidéo');
  }

  /**
   * L'état d'une vidéo : `ready` seul vaut « prête ». Un état absent ou inconnu se lit `traitement`, jamais
   * `prete` : la créa ne se lance que sur une vidéo que Meta dit prête. La durée du traitement n'est pas
   * documentée : c'est l'écran qui attend, borné, et la création qui refuse une vidéo pas prête.
   *
   * ⚠️ LE COMPTE DE LA VIDÉO N'EST PAS VÉRIFIÉ, faute de le savoir lire : le nœud `Video` de Graph ne documente
   * aucun champ de compte publicitaire (`from` désigne le profil qui l'a déposée ; référence relue le 2026-09-28),
   * contrairement aux audiences, relues sur l'arête du compte (`etatAudiences`). Ce qui borne : la lecture se fait avec le
   * jeton de CET espace, donc sur une vidéo que ce client peut voir, et une vidéo d'un autre de ses comptes fait
   * refuser la créa par Meta, dont le message s'affiche. Même limite pour {@link vignetteVideo}.
   */
  async etatVideo(videoId: string, jeton: string): Promise<EtatVideo> {
    const brut = await this.call(`${this.baseUrl}/${this.version}/${encodeURIComponent(videoId)}?fields=status`, {
      headers: { Authorization: `Bearer ${jeton}` },
    });
    const lu = etatVideoSchema.safeParse(brut);
    const s = lu.success ? lu.data.status : undefined;
    const statut = s?.video_status;
    const progression = s?.processing_progress;
    return {
      etat: statut === 'ready' ? 'prete' : statut === 'error' || statut === 'expired' ? 'erreur' : 'traitement',
      progression: progression !== undefined && Number.isFinite(progression) ? progression : null,
    };
  }

  /**
   * La vignette d'une vidéo, comme empreinte d'image utilisable par la créa : la vignette PRÉFÉRÉE de Meta (la
   * première à défaut), rapatriée puis redéposée par `adimages`.
   * 🔴 On ne cite jamais l'adresse du CDN de Meta dans la créa : elle est signée et périssable, et une créa qui
   * pointe vers une image expirée perd sa vignette sans que personne ne le voie.
   */
  async vignetteVideo(comptePubId: string, jeton: string, videoId: string): Promise<string> {
    const brut = await this.call(
      `${this.baseUrl}/${this.version}/${encodeURIComponent(videoId)}/thumbnails?fields=uri,is_preferred`,
      { headers: { Authorization: `Bearer ${jeton}` } },
    );
    const lu = vignettesSchema.safeParse(brut);
    const liste = (lu.success ? lu.data.data ?? [] : []).filter((v) => typeof v.uri === 'string' && v.uri !== '');
    const choisie = liste.find((v) => v.is_preferred === true) ?? liste[0];
    if (choisie?.uri === undefined) throw new Error('Meta n’a rendu aucune vignette pour cette vidéo');
    return this.televerserImage(comptePubId, jeton, await this.rapatrierVignette(choisie.uri));
  }

  /**
   * Rapatrie une vignette depuis l'adresse que Meta a rendue : HTTPS seulement, SANS le jeton du client (l'adresse
   * est signée, et un jeton n'a rien à faire chez un CDN), bornée au plafond d'un visuel, et vérifiée sur sa
   * signature : c'est une image qu'on redépose sous l'identité du client.
   */
  private async rapatrierVignette(uri: string): Promise<string> {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      throw new Error('Meta a rendu une adresse de vignette illisible');
    }
    if (url.protocol !== 'https:') throw new Error('Meta a rendu une adresse de vignette qui n’est pas en HTTPS');
    const res = await this.telecharger(url.toString(), { signal: AbortSignal.timeout(DELAI_VIGNETTE_MS) });
    if (!res.ok) throw new Error(`la vignette de la vidéo n’a pas pu être rapatriée (HTTP ${res.status})`);
    const lu = await lireOctetsBornes(res, TAILLE_VISUEL_PUB_MAX);
    if (lu.octets === null) {
      throw new Error(lu.trop_gros ? 'la vignette de la vidéo est trop lourde' : 'la vignette de la vidéo est arrivée incomplète');
    }
    const type = typeImage(lu.octets);
    if (type !== 'image/jpeg' && type !== 'image/png') throw new Error('la vignette de la vidéo n’est pas une image JPEG ou PNG');
    return lu.octets.toString('base64');
  }

  /**
   * Les audiences personnalisées du compte publicitaire, une page de {@link AUDIENCES_PAR_PAGE}. Toutes sont
   * rendues, utilisables ou non : l'écran ne propose que les premières et dit pourquoi les autres ne le sont pas.
   * Une audience absente de la liste (pas partagée avec ce compte) ne peut pas être expliquée : l'écran le dit.
   */
  async audiences(comptePubId: string, jeton: string): Promise<ListeAudiencesPub> {
    const qs = new URLSearchParams({ fields: CHAMPS_AUDIENCE, limit: String(AUDIENCES_PAR_PAGE) });
    const brut = await this.call(`${this.urlCompte(comptePubId, 'customaudiences')}?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${jeton}` },
    });
    const lu = listeAudiencesSchema.safeParse(brut);
    if (!lu.success) return { audiences: [], tronquee: false };
    return {
      audiences: (lu.data.data ?? []).map(versAudience).filter((a): a is AudiencePub => a !== null),
      tronquee: (lu.data.paging?.next ?? '') !== '',
    };
  }

  /**
   * L'état des SEULES audiences qu'une publicité veut cibler, relu à la création sur l'ARÊTE DU COMPTE
   * (`/act_{id}/customaudiences`) : ce que ce compte peut cibler, audiences possédées ET partagées avec lui.
   * Une audience absente de la table n'est pas ciblable par ce compte : l'appelant la refuse.
   *
   * 🔴 L'APPARTENANCE SE LIT DANS CETTE LISTE, JAMAIS DANS `account_id`. Une audience PARTAGÉE avec le compte porte
   * l'`account_id` de son PROPRIÉTAIRE (ou aucun) : l'exiger égal au compte de l'espace refusait toutes les audiences
   * partagées, qui sont justement celles qu'une agence ou un groupe prépare pour ses comptes. Et une lecture par
   * identifiant (`GET /?ids=`) rendait l'audience de n'importe quel compte que le jeton voit.
   *
   * ⚠️ PAGE PAR PAGE, jusqu'à {@link AUDIENCES_MAX_COMPTE} : une audience de la page 2 ne doit pas passer pour
   * inconnue. On s'arrête dès que toutes les audiences demandées sont trouvées. La page suivante se demande par le
   * curseur `after`, sur notre adresse : l'adresse `next` rendue par Meta n'est jamais suivie avec le jeton.
   */
  async etatAudiences(comptePubId: string, ids: readonly string[], jeton: string): Promise<Map<string, AudiencePub>> {
    const out = new Map<string, AudiencePub>();
    const voulues = new Set(ids);
    let apres: string | null = null;
    for (let page = 0; page < PAGES_AUDIENCES_MAX && out.size < voulues.size; page += 1) {
      const qs = new URLSearchParams({
        fields: CHAMPS_AUDIENCE, limit: String(AUDIENCES_PAR_PAGE), ...(apres !== null ? { after: apres } : {}),
      });
      const brut = await this.call(`${this.urlCompte(comptePubId, 'customaudiences')}?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${jeton}` },
      });
      const lu = listeAudiencesSchema.safeParse(brut);
      if (!lu.success) break;
      for (const ligne of lu.data.data ?? []) {
        const a = versAudience(ligne);
        if (a !== null && voulues.has(a.id)) out.set(a.id, a);
      }
      // Pas de page suivante annoncée, ou pas de curseur pour la demander : la liste du compte est lue.
      apres = (lu.data.paging?.next ?? '') !== '' ? lu.data.paging?.cursors?.after ?? null : null;
      if (apres === null || apres === '') break;
    }
    return out;
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
   * Supprime la campagne, ce qui emporte ce qu'elle contient : le rattrapage d'une création à moitié faite, en un
   * seul appel puisque Meta supprime en cascade.
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
   * Le suivi : ce que les campagnes sont devenues chez Meta, en deux appels pour toutes les campagnes d'un compte
   * (lecture par lot `GET /?ids=`, par paquets de {@link IDS_PAR_APPEL}). Un appel par campagne dépasserait le
   * niveau d'accès « Limited » de l'API Marketing et briderait le compte pour tout le reste, création comprise.
   */
  async lireCampagnes(campagneIds: readonly string[], jeton: string): Promise<Map<string, EtatCampagneMeta>> {
    const out = new Map<string, EtatCampagneMeta>();
    for (const paquet of parPaquets(campagneIds, IDS_PAR_APPEL)) {
      const qs = new URLSearchParams({
        ids: paquet.join(','),
        // Le budget vit sur l'ensemble (`payloadEnsemble` pose `lifetime_budget` sur l'ad set), pas sur la campagne :
        // on l'expanse depuis la campagne, sans appel de plus, une campagne créée ici n'ayant qu'un ensemble.
        fields: 'id,name,effective_status,issues_info,start_time,stop_time,adsets.limit(1){lifetime_budget}',
      });
      const brut = await this.call(`${this.baseUrl}/${this.version}/?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${jeton}` },
      });
      const lu = lotCampagnesSchema.safeParse(brut);
      if (!lu.success) continue;
      for (const [id, c] of Object.entries(lu.data)) {
        out.set(id, {
          statut: c.effective_status ?? null,
          // Le premier motif seulement : l'écran dit une raison actionnable, et le lien vers le Gestionnaire mène à
          // la liste complète.
          motifRefus: c.issues_info?.[0]?.error_summary ?? c.issues_info?.[0]?.error_message ?? null,
          debut: c.start_time ?? null,
          fin: c.stop_time ?? null,
          budgetTotal: montantMajeur(c.adsets?.data?.[0]?.lifetime_budget),
        });
      }
    }
    return out;
  }

  /**
   * La dépense, les clics, les impressions et la couverture par campagne, depuis le début
   * (`date_preset=maximum`), en un seul appel. Clics = `inline_link_clicks`, les clics sur le lien, et non
   * `clicks` qui compte tout clic sur la pub ; champ à confirmer contre le Gestionnaire au premier jour du pilote.
   * Couverture = `reach`, des personnes distinctes : elle ne s'additionne pas d'un jour à l'autre, d'où la
   * lecture sur toute la durée plutôt qu'un cumul de notre côté.
   */
  async lireDepenses(campagneIds: readonly string[], jeton: string): Promise<Map<string, DepensePub>> {
    const out = new Map<string, DepensePub>();
    for (const paquet of parPaquets(campagneIds, IDS_PAR_APPEL)) {
      const qs = new URLSearchParams({
        ids: paquet.join(','),
        fields: 'insights.date_preset(maximum){spend,inline_link_clicks,impressions,reach}',
      });
      const brut = await this.call(`${this.baseUrl}/${this.version}/?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${jeton}` },
      });
      const lu = lotInsightsSchema.safeParse(brut);
      if (!lu.success) continue;
      for (const [id, c] of Object.entries(lu.data)) {
        const ligne = c.insights?.data?.[0];
        // Aucune ligne est un cas normal (rien encore diffusé) : `null`, et l'écran dit « pas encore de diffusion »
        // plutôt qu'une dépense de zéro qui ressemblerait à une mesure.
        if (ligne === undefined) continue;
        out.set(id, {
          // Meta rend la dépense en chaîne, dans l'unité principale de la devise : l'inverse de ce qu'il attend en
          // écriture pour un budget.
          depense: nombreFini(ligne.spend),
          clics: entierOuRien(ligne.inline_link_clicks),
          impressions: entierOuRien(ligne.impressions),
          couverture: entierOuRien(ligne.reach),
        });
      }
    }
    return out;
  }

  /**
   * Le jeton de Page, dérivé du jeton du client, jamais stocké. La documentation de Meta l'exige pour la créa,
   * qui agit sur la Page. `null` plutôt qu'une levée : l'appelant retombe sur le jeton du client, et un refus de
   * Meta s'affiche tel quel.
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
      console.warn(`jeton de Page ${pageId} non dérivé, on garde le jeton du client :`, messageDe(err));
      return null;
    }
  }
}
