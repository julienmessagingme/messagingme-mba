import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sha256Hex, timingSafeEqualStr } from '../lib/signature';
import { normalizePhone } from '../crm/phone';
import { waIdOf } from '../crm/identity';
import { extraireDuPayload } from '../webhook-entrant/mapping';
import type { WebhookPublic } from '../webhook-entrant/store.pg';
import { RateLimiter } from '../auth/rate-limit';

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
   * Écrit le contact par le CHEMIN PARTAGÉ (`upsertContactsFromApi`) : mêmes règles de normalisation, de
   * résolution de champ et de validation que l'API publique et l'import CSV. Le redériver ici créerait un
   * second contact pour la même personne le jour où l'une des deux versions changerait.
   */
  ecrireContact(
    tenantId: string,
    entree: { phone: string; name: string | null; fields: Record<string, string> },
  ): Promise<{ statut: 'created' | 'updated' | 'error'; raison?: string }>;
  /** Publie l'événement d'automation (file). C'est le worker qui décide ensuite quoi déclencher. */
  publish(tenantId: string, ev: { kind: 'webhook'; waId: string; webhookId: string }): Promise<void>;
  /** Plafond de débit par webhook. Absent -> plafond par défaut (voir `registerWebhookEntrant`). */
  limiter?: RateLimiter;
}

/** Réponse rendue au tiers : elle DIT ce qui s'est passé, puisque tout est en 200. */
interface Compte {
  ok: true;
  contact: 'cree' | 'trouve' | 'absent';
  champs: number;
  scenario: 'publie' | 'aucun';
  /** Pourquoi rien n'a été écrit, le cas échéant. Un mapping muet sans trace est indébogable. */
  raison?: string;
  /** Chemins du mapping qui n'ont rien rendu sur CET appel. */
  ignores?: string[];
}

export function registerWebhookEntrant(app: FastifyInstance, deps: WebhookEntrantRouteDeps): void {
  // Plafond de débit par WEBHOOK (pas par IP) : c'est le budget d'une intégration, et l'IP d'un Zapier n'a
  // aucune stabilité. Singleton, comme le limiteur de `/v1`.
  const limiter = deps.limiter ?? new RateLimiter(120, 60_000);

  app.post('/w/:code', { bodyLimit: TAILLE_MAX_CORPS }, async (req, reply) => {
    const { code } = req.params as { code: string };
    const normalise = typeof code === 'string' ? code.trim().toLowerCase() : '';

    // Forme du code vérifiée AVANT la base : cette URL reçoit des robots et des scans, aucune raison de leur
    // offrir une requête SQL par essai.
    if (!CODE_RE.test(normalise)) return reply.code(404).send({ error: 'webhook introuvable' });

    const hook = await deps.getByCode(normalise);
    // Code inconnu ET webhook désactivé rendent la MÊME chose : un tiers n'a pas à distinguer « ce webhook
    // n'existe pas » de « il existe mais il est éteint ».
    if (!hook || !hook.enabled) return reply.code(404).send({ error: 'webhook introuvable' });

    if (!limiter.take(hook.id)) {
      // La réponse ne révèle ni le plafond ni l'espace : juste « trop d'appels ».
      return reply.code(429).send({ error: 'trop d’appels, réessayez dans une minute' });
    }

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
    const compte: Compte = { ok: true, contact: 'absent', champs: 0, scenario: 'aucun' };
    if (ex.ignores.length > 0) compte.ignores = ex.ignores;

    const fini = async (contactCreated: boolean): Promise<Compte> => {
      // Le payload est enregistré QUOI QU'IL ARRIVE : c'est ce qui permet de construire le mapping dans
      // l'écran, et le seul moyen de déboguer « pourquoi rien ne se passe ». Best-effort : son échec ne doit
      // pas transformer un appel réussi en erreur pour le tiers.
      try {
        await deps.recordCall(hook.tenantId, hook.id, payload, contactCreated);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`webhook ${hook.id} : payload non enregistré :`, err instanceof Error ? err.message : err);
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

    const res = await deps.ecrireContact(hook.tenantId, { phone: e164, name: ex.nom, fields: ex.champs });
    if (res.statut === 'error') {
      // Une valeur refusée par la validation de champ n'est PAS une panne : le tiers doit la voir, et ne doit
      // pas réessayer en boucle. D'où 200 avec la raison, comme pour les autres refus métier.
      compte.raison = res.raison ?? 'contact non écrit';
      return reply.code(200).send(await fini(false));
    }

    compte.contact = res.statut === 'created' ? 'cree' : 'trouve';
    compte.champs = Object.keys(ex.champs).length;
    // « publié », pas « lancé » : les six garde-fous de `runAutomations` (contact bloqué, anti-rebond,
    // condition, plafond horaire, un seul parcours actif) s'appliquent ensuite, et la route ne le sait pas.
    if (hook.automationId !== null) compte.scenario = 'publie';

    // Le payload est enregistré AVANT la publication : si la file est indisponible, on veut quand même
    // pouvoir regarder ce que le tiers a envoyé.
    const reponse = await fini(res.statut === 'created');

    if (hook.automationId !== null) {
      // ⚠️ SEUL endroit où cette route laisse échapper une erreur, donc un 5xx. C'est délibéré : une file
      // indisponible est une panne, pas un refus métier, et la seule bonne réponse est de laisser le tiers
      // réessayer. Répondre 200 en annonçant « scénario publié » perdrait l'événement en silence.
      await deps.publish(hook.tenantId, { kind: 'webhook', waId, webhookId: hook.id });
    }

    return reply.code(200).send(reponse);
  });
}
