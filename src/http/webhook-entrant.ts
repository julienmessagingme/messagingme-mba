import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sha256Hex, timingSafeEqualStr } from '../lib/signature';
import { normalizePhone } from '../crm/phone';
import { waIdOf } from '../crm/identity';
import { extraireDuPayload } from '../webhook-entrant/mapping';
import type { WebhookPublic } from '../webhook-entrant/store.pg';
import { ClesResolues, RateLimiter, avertissementBorne, consommerEnSilence } from '../auth/rate-limit';
import { messageDe } from '../lib/erreur';

/**
 * Route PUBLIQUE des webhooks entrants : `POST /w/:code`. Un outil tiers (Zapier, Make, un CRM, un formulaire
 * de site) y poste du JSON ; on en extrait des valeurs vers des champs de contact, et on publie l'événement
 * qui déclenchera le scénario configuré.
 *
 * C'est, avec `/r/:code`, la surface la plus exposée du service. Quatre règles commandent ce fichier :
 *
 *  1. **Le tenant vient du CODE, jamais du corps.** `/hubspot/deal-stage` accepte un `tenantId` dans son
 *     payload : tolérable pour un connecteur maison à secret unique, inacceptable pour une URL qu'on remet à
 *     un tiers quelconque.
 *  2. **Aucune décision ici.** La route traduit « un appel est arrivé » en écriture de contact et en événement
 *     d'automation. Ce sont les garde-fous de `runAutomations` qui décident si un scénario part.
 *  3. **Toujours 200 sur un appel bien formé, même quand rien n'a été fait.** Un tiers qui reçoit une erreur
 *     réessaie en boucle, et beaucoup désactivent le webhook après quelques échecs. Le détail passe dans le
 *     corps de la réponse.
 *  4. **Jamais de 5xx à destination du tiers, SAUF panne de la file.** Cloudflare remplace le corps de
 *     toute réponse 5xx par sa propre page : le message deviendrait invisible au moment précis où on en a
 *     besoin. La seule exception est documentée plus bas : une file indisponible n'est pas un refus métier,
 *     et laisser le tiers réessayer vaut mieux que perdre l'événement en silence.
 */

/** Corps brut, capturé par le parser JSON global (celui du receiver Meta). */
type WithRawBody = FastifyRequest & { rawBody?: Buffer };

/** 26 caractères base32 minuscules (`newWebhookCode`). Tout le reste est refusé sans toucher la base. */
const CODE_RE = /^[0-9a-hjkmnp-tv-z]{26}$/;

/** Corps accepté. Au-delà, ce n'est plus un événement, c'est un export. */
export const TAILLE_MAX_CORPS = 128_000;

/** Ce que la route sait faire écrire, sans savoir comment. */
export interface WebhookEntrantRouteDeps {
  getByCode(code: string): Promise<WebhookPublic | null>;
  /** Enregistre le dernier payload + l'horodatage, et compte le contact créé. Best-effort. */
  recordCall(tenantId: string, id: string, payload: unknown, contactCreated: boolean): Promise<void>;
  /**
   * Ce contact existe-t-il déjà dans cet espace ?
   *
   * Appelée UNIQUEMENT quand la création est désactivée : dans le cas courant, `ecrireContact` rend déjà
   * `created`/`updated`, et interroger d'abord serait une requête de plus sur le chemin chaud pour une
   * réponse qu'on obtient de toute façon.
   */
  trouverWaId(tenantId: string, waId: string): Promise<string | null>;
  /**
   * Écrit le contact par le CHEMIN PARTAGÉ (`upsertContactsFromApi`) : mêmes règles que la création à la main
   * de la console ; sa préparation des champs (`preparateurDeChamps`) est aussi celle de l'API publique. Le
   * redériver ici créerait un second contact pour la même personne le jour où l'une des deux versions changerait.
   */
  ecrireContact(
    tenantId: string,
    entree: {
      phone: string;
      name: string | null;
      fields: Record<string, string>;
      /** Le contact est-il considéré comme consentant ? Affirmé par l'opérateur, webhook par webhook. */
      optIn: boolean;
      /** D'où vient ce consentement, pour la trace : `webhook:<nom>`. */
      optInSource: string;
    },
  ): Promise<{ statut: 'created' | 'updated' | 'error'; raison?: string }>;
  /** Publie l'événement d'automation (file). C'est le worker qui décide ensuite quoi déclencher. */
  publish(tenantId: string, ev: { kind: 'webhook'; waId: string; webhookId: string }): Promise<void>;
  /** Plafond de débit par webhook. Absent -> plafond par défaut (voir `registerWebhookEntrant`). */
  limiter?: RateLimiter;
  /**
   * Le budget COMMUN des codes jamais vus, pris avant la base (`CODES_INCONNUS_PAR_MINUTE`).
   *
   * 🔴 REQUIS, et c'est délibéré : optionnel, il finirait par manquer à un câblage, et la borne disparaîtrait
   * sans bruit. Le désactiver se fait par la configuration (0), pas en oubliant une dépendance.
   */
  budgetInconnus: RateLimiter;
}

/** Réponse rendue au tiers : elle DIT ce qui s'est passé, puisque tout est en 200. */
interface Compte {
  ok: true;
  contact: 'cree' | 'trouve' | 'absent';
  champs: number;
  scenario: 'publie' | 'aucun';
  /** Une campagne AU FIL DE L'EAU attend-elle les arrivants de cette adresse ? Dit à l'intégrateur que son
   *  appel nourrit un envoi, même quand aucun scénario n'est branché. */
  campagne: 'alimentee' | 'aucune';
  /** Pourquoi rien n'a été écrit, le cas échéant. Un mapping muet sans trace est indébogable. */
  raison?: string;
  /** Chemins du mapping qui n'ont rien rendu sur CET appel. */
  ignores?: string[];
}

export function registerWebhookEntrant(app: FastifyInstance, deps: WebhookEntrantRouteDeps): void {
  // Plafond de débit par WEBHOOK (pas par IP) : c'est le budget d'une intégration, et l'IP d'un Zapier n'a
  // aucune stabilité. Singleton, comme le limiteur de `/v1`.
  // AUCUN plafond de clés, délibérément : le limiteur n'est consulté que sur des webhooks qui existent et sont
  // actifs, donc sa table est bornée par leur nombre. Un plafond de clés y rouvrirait l'éviction d'un vrai
  // code par des codes inventés (cf. la prise du plafond, plus bas).
  const limiter = deps.limiter ?? new RateLimiter(120, 60_000);
  // Les codes déjà résolus par ce process : ils échappent au budget des codes jamais vus (`ClesResolues`).
  const connus = new ClesResolues(1000);
  const avertirBudget = avertissementBorne(
    'webhook entrant : budget des codes jamais vus épuisé (CODES_INCONNUS_PAR_MINUTE), des codes inconnus reçoivent 429',
  );

  app.post('/w/:code', { bodyLimit: TAILLE_MAX_CORPS }, async (req, reply) => {
    const { code } = req.params as { code: string };
    const normalise = typeof code === 'string' ? code.trim().toLowerCase() : '';

    // Forme du code vérifiée AVANT la base : cette URL reçoit des robots et des scans, aucune raison de leur
    // offrir une requête SQL par essai.
    if (!CODE_RE.test(normalise)) return reply.code(404).send({ error: 'webhook introuvable' });

    // 🔴 LE FREIN DES CODES JAMAIS VUS, AVANT LA BASE (décision de Julien du 2026-09-21). Un code inventé bien
    // formé coûtait une lecture en base par essai. Il consomme désormais un budget COMMUN, EN SILENCE (ses
    // en-têtes n'appartiennent à personne), et un budget épuisé se journalise au plus une fois par minute. Un
    // code déjà résolu n'y est plus soumis : une attaque qui épuise le budget ne coupe pas les intégrations en
    // service. La clé du budget est une CONSTANTE : sa table ne grossit pas, et aucun code inventé ne peut en
    // évincer un vrai.
    const connu = connus.connait(normalise);
    if (!connu && !(await consommerEnSilence(deps.budgetInconnus, 'codes-inconnus', reply, 'trop d’appels, réessayez dans une minute'))) {
      avertirBudget();
      return;
    }

    // 🔴 LE PLAFOND PAR WEBHOOK NE COMPTE QUE DES CODES QUI EXISTENT. Il se prend AVANT la base pour un code déjà
    // résolu par ce process (un refus ne coûte plus de lecture), APRÈS pour les autres, une seule fois par appel.
    // Le programme II l'avait remonté avant `getByCode` pour TOUS les codes : sa clé devenait alors choisie par
    // l'APPELANT, des codes inventés remplissaient la table, et le VRAI code d'un client, dont l'entrée expire à
    // chaque fenêtre, était refusé à la suivante (défaut corrigé le 2026-09-21). Seuls les codes résolus entrent
    // dans `connus`, donc la table du limiteur reste bornée par le nombre de webhooks qui existent.
    //
    // Ce qu'on protège d'un code qui a FUITÉ, ce sont les écritures qui suivent : le contact, le payload
    // enregistré, l'événement d'automation. Il reste AVANT la vérification du secret : essayer des secrets en
    // rafale sur un code connu est plafonné aussi. La clé est le code et non l'identifiant du webhook : les deux
    // sont en correspondance stricte. La réponse ne révèle ni le plafond ni l'espace : juste « trop d'appels ».
    const tropDAppels = (): unknown => reply.code(429).send({ error: 'trop d’appels, réessayez dans une minute' });
    if (connu && !limiter.take(normalise)) return tropDAppels();

    const hook = await deps.getByCode(normalise);
    // Code inconnu ET webhook désactivé rendent la MÊME chose : un tiers n'a pas à distinguer « ce webhook
    // n'existe pas » de « il existe mais il est éteint ». Et un code qui ne se résout plus perd son laissez-passer.
    if (!hook || !hook.enabled) {
      connus.oublier(normalise);
      return reply.code(404).send({ error: 'webhook introuvable' });
    }
    connus.retenir(normalise);
    // Première résolution dans ce process : le plafond se prend ici, sur un code qui existe.
    if (!connu && !limiter.take(normalise)) return tropDAppels();

    if (hook.secretHash !== null) {
      const brut = req.headers['x-webhook-secret'];
      const fourni = Array.isArray(brut) ? brut[0] : brut;
      // Absent, faux, ou celui d'un AUTRE webhook : même réponse. La comparaison porte sur l'empreinte, en
      // temps constant, comme partout ailleurs dans ce dépôt.
      if (typeof fourni !== 'string' || !timingSafeEqualStr(sha256Hex(fourni), hook.secretHash)) {
        return reply.code(401).send({ error: 'secret invalide' });
      }
    }

    // ⚠️ Le parser JSON global transforme un corps INVALIDE en `{}` sans lever (il est écrit pour le webhook
    // Meta, où la signature tranche ensuite). On ne peut donc pas conclure d'un objet vide qu'on a reçu du
    // JSON valide : c'est le corps BRUT qui tranche.
    const raw = (req as WithRawBody).rawBody;
    if (!raw || raw.length === 0) return reply.code(400).send({ error: 'corps vide : postez un objet JSON' });
    try {
      JSON.parse(raw.toString('utf8'));
    } catch {
      // 400 et pas 200 : ici l'intégrateur DOIT voir son erreur, et il n'y a rien à enregistrer comme payload.
      return reply.code(400).send({ error: 'corps JSON invalide' });
    }
    const payload = req.body;

    const ex = extraireDuPayload(payload, hook.mapping);
    // Deux consommateurs possibles d'un arrivant, indépendants : le scénario attaché au webhook, et les
    // campagnes au fil de l'eau qui s'en nourrissent. UN SEUL événement est publié pour les deux ; c'est le
    // worker qui sert l'un, l'autre, ou les deux.
    const alimenteCampagne = hook.alimenteCampagne === true;
    const publier = hook.automationId !== null || alimenteCampagne;
    const compte: Compte = {
      ok: true, contact: 'absent', champs: 0,
      scenario: 'aucun',
      campagne: alimenteCampagne ? 'alimentee' : 'aucune',
    };
    if (ex.ignores.length > 0) compte.ignores = ex.ignores;

    const fini = async (contactCreated: boolean): Promise<Compte> => {
      // Le payload est enregistré QUOI QU'IL ARRIVE : c'est ce qui permet de construire le mapping dans
      // l'écran, et le seul moyen de déboguer « pourquoi rien ne se passe ». Best-effort : son échec ne doit
      // pas transformer un appel réussi en erreur pour le tiers.
      try {
        await deps.recordCall(hook.tenantId, hook.id, payload, contactCreated);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`webhook ${hook.id} : payload non enregistré :`, messageDe(err));
      }
      return compte;
    };

    if (ex.telephone === null) {
      compte.raison = hook.mapping.some((r) => r.cible === 'sys:phone')
        ? 'aucun téléphone dans cet appel'
        : 'aucun champ du mapping ne vise le téléphone';
      return reply.code(200).send(await fini(false));
    }

    // MÊME normalisation que l'import CSV, l'API publique et le connecteur HubSpot : un contact doit être
    // reconnu à l'identique quel que soit le chemin par lequel son numéro arrive.
    const e164 = normalizePhone(ex.telephone, 'FR').e164;
    const waId = e164 ? waIdOf(e164, null) : null;
    if (!e164 || !waId) {
      compte.raison = 'téléphone inexploitable';
      return reply.code(200).send(await fini(false));
    }

    if (!hook.createContact && (await deps.trouverWaId(hook.tenantId, waId)) === null) {
      // Le choix est celui de l'opérateur (case « créer les contacts inconnus »), et la réponse le DIT : sans
      // ça, l'intégrateur cherche un bug là où il n'y a qu'un réglage.
      compte.raison = 'contact inconnu, et la création est désactivée sur ce webhook';
      return reply.code(200).send(await fini(false));
    }

    const res = await deps.ecrireContact(hook.tenantId, {
      phone: e164,
      name: ex.nom,
      fields: ex.champs,
      optIn: hook.optIn,
      // La trace dit PAR OÙ le consentement est entré, pas seulement qu'il existe : c'est ce qui permet de
      // le justifier ensuite. Tronquée, la colonne n'ayant pas vocation à recevoir un nom sans limite.
      optInSource: `webhook:${hook.name}`.slice(0, 100),
    });
    if (res.statut === 'error') {
      // Une valeur refusée par la validation de champ n'est PAS une panne : le tiers doit la voir, et ne doit
      // pas réessayer en boucle. D'où 200 avec la raison, comme pour les autres refus métier.
      compte.raison = res.raison ?? 'contact non écrit';
      return reply.code(200).send(await fini(false));
    }

    compte.contact = res.statut === 'created' ? 'cree' : 'trouve';
    compte.champs = Object.keys(ex.champs).length;
    // « publié », pas « lancé » : les garde-fous de `runAutomations` (contact bloqué, anti-rebond, condition,
    // plafond horaire) s'appliquent ensuite, et la route ne le sait pas.
    // ⚠️ « un seul parcours actif » ne fait plus partie de cette liste depuis le 2026-09-07 : un parcours en
    // cours ne bloque plus rien, il est CLOS par le démarrage suivant (`runFrom`).
    if (hook.automationId !== null) compte.scenario = 'publie';

    // Le payload est enregistré AVANT la publication : si la file est indisponible, on veut quand même
    // pouvoir regarder ce que le tiers a envoyé.
    const reponse = await fini(res.statut === 'created');

    if (publier) {
      // ⚠️ SEUL endroit où cette route laisse échapper une erreur, donc un 5xx. C'est délibéré : une file
      // indisponible est une panne, pas un refus métier, et la seule bonne réponse est de laisser le tiers
      // réessayer. Répondre 200 en annonçant « scénario publié » perdrait l'événement en silence. Vaut à
      // l'identique pour une campagne au fil de l'eau : l'événement perdu, c'est un lead jamais contacté.
      await deps.publish(hook.tenantId, { kind: 'webhook', waId, webhookId: hook.id });
    }

    return reply.code(200).send(reponse);
  });
}
