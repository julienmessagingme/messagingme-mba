import { z } from 'zod';
import { ClientGraph } from './graph';
import { sansPrefixeAct } from './pubs';
import { STATUT_ACTIF, STATUT_PAUSE } from './pubs-payloads';
import { messageDe } from '../lib/erreur';

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

/** La dépense et les clics d'une campagne, depuis le début. */
export interface DepensePub {
  depense: number | null;
  clics: number | null;
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
 * Garantit le fini, pas l'entier : un `inline_link_clicks` fractionnaire casserait encore l'écriture de `clics`.
 * Zéro est une mesure valide ici, contrairement au budget.
 */
function nombreFini(brut: string | undefined): number | null {
  if (brut === undefined) return null;
  const n = Number(brut);
  return Number.isFinite(n) ? n : null;
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
  /** L'adresse d'un objet du compte publicitaire, avec son préfixe `act_` remis. */
  private urlCompte(comptePubId: string, chemin: string): string {
    return `${this.baseUrl}/${this.version}/act_${encodeURIComponent(sansPrefixeAct(comptePubId))}/${chemin}`;
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
   * La dépense et les clics par campagne, depuis le début (`date_preset=maximum`). Clics = `inline_link_clicks`,
   * les clics sur le lien, et non `clicks` qui compte tout clic sur la pub ; champ à confirmer contre le
   * Gestionnaire au premier jour du pilote.
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
        // Aucune ligne est un cas normal (rien encore diffusé) : `null`, et l'écran dit « pas encore de diffusion »
        // plutôt qu'une dépense de zéro qui ressemblerait à une mesure.
        if (ligne === undefined) continue;
        out.set(id, {
          // Meta rend la dépense en chaîne, dans l'unité principale de la devise : l'inverse de ce qu'il attend en
          // écriture pour un budget.
          depense: nombreFini(ligne.spend),
          clics: nombreFini(ligne.inline_link_clicks),
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
