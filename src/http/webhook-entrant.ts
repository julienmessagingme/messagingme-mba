import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sha256Hex, timingSafeEqualStr } from '../lib/signature';
import { normalizePhone } from '../crm/phone';
import { waIdOf } from '../crm/identity';
import { extraireDuPayload } from '../webhook-entrant/mapping';
import type { WebhookPublic } from '../webhook-entrant/store.pg';
import { ClesResolues, RateLimiter, avertissementBorne, consommerEnSilence } from '../auth/rate-limit';
import { messageDe } from '../lib/erreur';

/**
 * Route publique des webhooks entrants : `POST /w/:code`. Un outil tiers (Zapier, Make, un CRM, un formulaire)
 * y poste du JSON ; on en extrait des valeurs vers des champs de contact et on publie l'événement qui déclenchera
 * le scénario configuré. Quatre règles :
 *  1. 🔴 L'espace vient du code, jamais du corps : cette URL est remise à un tiers quelconque.
 *  2. Aucune décision ici : ce sont les garde-fous de `runAutomations` qui décident si un scénario part.
 *  3. Toujours 200 sur un appel bien formé, même quand rien n'a été fait (un tiers qui reçoit une erreur réessaie
 *     en boucle ou désactive le webhook) : le détail passe dans le corps.
 *  4. Jamais de 5xx vers le tiers (Cloudflare en remplacerait le corps), sauf panne de la file : laisser le
 *     tiers réessayer vaut mieux que perdre l'événement.
 */

/** Corps brut, capturé par le parser JSON global (celui du receiver Meta). */
type WithRawBody = FastifyRequest & { rawBody?: Buffer };

/** 26 caractères base32 minuscules (`newWebhookCode`). Tout le reste est refusé sans toucher la base. */
const CODE_RE = /^[0-9a-hjkmnp-tv-z]{26}$/;

/** Corps accepté. Au-delà, ce n'est plus un événement, c'est un export. */
export const TAILLE_MAX_CORPS = 128_000;

/** Ce que la route sait faire écrire, sans savoir comment. */
export interface WebhooksEntrantsDep {
  getByCode(code: string): Promise<WebhookPublic | null>;
  /** Enregistre le dernier payload + l'horodatage, et compte le contact créé. Best-effort. */
  recordCall(tenantId: string, id: string, payload: unknown, contactCreated: boolean): Promise<void>;
}

export interface WebhookEntrantRouteDeps {
  webhooks: WebhooksEntrantsDep;
  /**
   * Ce contact existe-t-il déjà dans cet espace ? Appelée seulement quand la création est désactivée : sinon
   * `ecrireContact` rend déjà `created`/`updated`, sans requête de plus sur le chemin chaud.
   */
  trouverWaId(tenantId: string, waId: string): Promise<string | null>;
  /**
   * Écrit le contact par le chemin partagé (`upsertContactsFromApi`) : mêmes règles que la création à la main
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
   * Le budget commun des codes jamais vus, pris avant la base (`CODES_INCONNUS_PAR_MINUTE`). Requis : il se
   * désactive par la configuration (0), pas en oubliant une dépendance.
   */
  budgetInconnus: RateLimiter;
}

/** Réponse rendue au tiers : elle dit ce qui s'est passé, puisque tout est en 200. */
interface Compte {
  ok: true;
  contact: 'cree' | 'trouve' | 'absent';
  champs: number;
  scenario: 'publie' | 'aucun';
  /** Une campagne au fil de l'eau attend-elle les arrivants de cette adresse ? Dit à l'intégrateur que son
  *  appel nourrit un envoi, même quand aucun scénario n'est branché. */
  campagne: 'alimentee' | 'aucune';
  /** Pourquoi rien n'a été écrit, le cas échéant. Un mapping muet sans trace est indébogable. */
  raison?: string;
  /** Chemins du mapping qui n'ont rien rendu sur cet appel. */
  ignores?: string[];
}

export function registerWebhookEntrant(app: FastifyInstance, deps: WebhookEntrantRouteDeps): void {
  // Plafond de débit par webhook (pas par IP) : c'est le budget d'une intégration, et l'IP d'un Zapier n'a
  // aucune stabilité. Aucun plafond de clés : le limiteur n'est consulté que sur des webhooks existants et
  // actifs, donc sa table est bornée ; un plafond de clés rouvrirait l'éviction d'un vrai code par des inventés.
  const limiter = deps.limiter ?? new RateLimiter(120, 60_000);
  // Les codes déjà résolus par ce process : ils échappent au budget des codes jamais vus (`ClesResolues`).
  const connus = new ClesResolues(1000);
  const avertirBudget = avertissementBorne(
    'webhook entrant : budget des codes jamais vus épuisé (CODES_INCONNUS_PAR_MINUTE), des codes inconnus reçoivent 429',
  );

  app.post('/w/:code', { bodyLimit: TAILLE_MAX_CORPS }, async (req, reply) => {
    const { code } = req.params as { code: string };
    const normalise = typeof code === 'string' ? code.trim().toLowerCase() : '';

    // Forme du code vérifiée avant la base : cette URL reçoit des robots et des scans, aucune raison de leur
    // offrir une requête SQL par essai.
    if (!CODE_RE.test(normalise)) return reply.code(404).send({ error: 'webhook introuvable' });

    // Le frein des codes jamais vus, avant la base : un code inventé bien formé consomme un budget commun, en
    // silence (ses en-têtes n'appartiennent à personne), et un budget épuisé se journalise au plus une fois par
    // minute. Un code déjà résolu n'y est pas soumis. La clé du budget est une constante : aucun code inventé ne
    // peut en évincer un vrai.
    const connu = connus.connait(normalise);
    if (!connu && !(await consommerEnSilence(deps.budgetInconnus, 'codes-inconnus', reply, 'trop d’appels, réessayez dans une minute'))) {
      avertirBudget();
      return;
    }

    // Le plafond par webhook ne compte que des codes qui existent : avant la base pour un code déjà résolu par ce
    // process, après pour les autres, une fois par appel. Compté pour tous, sa clé serait choisie par l'appelant et
    // des codes inventés feraient refuser le vrai code d'un client. Il protège les écritures d'un code qui a fuité,
    // et reste avant la vérification du secret (essayer des secrets en rafale est plafonné aussi). La réponse ne
    // révèle ni le plafond ni l'espace.
    const tropDAppels = (): unknown => reply.code(429).send({ error: 'trop d’appels, réessayez dans une minute' });
    if (connu && !limiter.take(normalise)) return tropDAppels();

    const hook = await deps.webhooks.getByCode(normalise);
    // Code inconnu et webhook désactivé rendent la même chose : un tiers n'a pas à distinguer « ce webhook
    // n'existe pas » de « il est éteint ». Et un code qui ne se résout plus perd son laissez-passer.
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
      // Absent, faux, ou celui d'un autre webhook : même réponse. La comparaison porte sur l'empreinte, en
      // temps constant, comme partout ailleurs dans ce dépôt.
      if (typeof fourni !== 'string' || !timingSafeEqualStr(sha256Hex(fourni), hook.secretHash)) {
        return reply.code(401).send({ error: 'secret invalide' });
      }
    }

    // Le parser JSON global transforme un corps invalide en `{}` sans lever (il est écrit pour le webhook Meta,
    // où la signature tranche ensuite) : c'est le corps brut qui tranche.
    const raw = (req as WithRawBody).rawBody;
    if (!raw || raw.length === 0) return reply.code(400).send({ error: 'corps vide : postez un objet JSON' });
    try {
      JSON.parse(raw.toString('utf8'));
    } catch {
      // 400 et pas 200 : ici l'intégrateur doit voir son erreur, et il n'y a rien à enregistrer comme payload.
      return reply.code(400).send({ error: 'corps JSON invalide' });
    }
    const payload = req.body;

    const ex = extraireDuPayload(payload, hook.mapping);
    // Deux consommateurs possibles d'un arrivant, indépendants : le scénario attaché au webhook, et les
    // campagnes au fil de l'eau qui s'en nourrissent. Un seul événement est publié pour les deux ; c'est le
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
      // Le payload est enregistré quoi qu'il arrive : il sert à construire le mapping dans l'écran et à déboguer
      // « pourquoi rien ne se passe ». Au mieux : son échec ne transforme pas un appel réussi en erreur pour le tiers.
      try {
        await deps.webhooks.recordCall(hook.tenantId, hook.id, payload, contactCreated);
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

    // Même normalisation que l'import CSV, l'API publique et le connecteur HubSpot : un contact doit être
    // reconnu à l'identique quel que soit le chemin par lequel son numéro arrive.
    const e164 = normalizePhone(ex.telephone, 'FR').e164;
    const waId = e164 ? waIdOf(e164, null) : null;
    if (!e164 || !waId) {
      compte.raison = 'téléphone inexploitable';
      return reply.code(200).send(await fini(false));
    }

    if (!hook.createContact && (await deps.trouverWaId(hook.tenantId, waId)) === null) {
      // Le choix est celui de l'opérateur (case « créer les contacts inconnus »), et la réponse le dit : sans
      // ça, l'intégrateur cherche un bug là où il n'y a qu'un réglage.
      compte.raison = 'contact inconnu, et la création est désactivée sur ce webhook';
      return reply.code(200).send(await fini(false));
    }

    const res = await deps.ecrireContact(hook.tenantId, {
      phone: e164,
      name: ex.nom,
      fields: ex.champs,
      optIn: hook.optIn,
      // La trace dit par où le consentement est entré, pas seulement qu'il existe : c'est ce qui permet de le
      // justifier ensuite. Tronquée, la colonne n'ayant pas vocation à recevoir un nom sans limite.
      optInSource: `webhook:${hook.name}`.slice(0, 100),
    });
    if (res.statut === 'error') {
      // Une valeur refusée par la validation de champ n'est pas une panne : le tiers doit la voir, et ne doit
      // pas réessayer en boucle. D'où 200 avec la raison, comme pour les autres refus métier.
      compte.raison = res.raison ?? 'contact non écrit';
      return reply.code(200).send(await fini(false));
    }

    compte.contact = res.statut === 'created' ? 'cree' : 'trouve';
    compte.champs = Object.keys(ex.champs).length;
    // « publié », pas « lancé » : les garde-fous de `runAutomations` (contact bloqué, anti-rebond, condition,
    // plafond horaire) s'appliquent ensuite. Un parcours en cours ne bloque rien : le suivant le clôt (`runFrom`).
    if (hook.automationId !== null) compte.scenario = 'publie';

    // Le payload est enregistré avant la publication : si la file est indisponible, on veut quand même
    // pouvoir regarder ce que le tiers a envoyé.
    const reponse = await fini(res.statut === 'created');

    if (publier) {
      // Seul endroit où cette route laisse échapper une erreur, donc un 5xx : une file indisponible est une panne,
      // et répondre 200 perdrait l'événement en silence (pour une campagne au fil de l'eau, un lead jamais contacté).
      await deps.publish(hook.tenantId, { kind: 'webhook', waId, webhookId: hook.id });
    }

    return reply.code(200).send(reponse);
  });
}
