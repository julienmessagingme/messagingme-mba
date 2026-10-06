import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Guard } from '../auth/middleware';
import {
  planifierPublication, type Geste, type RelaisAPublier, type OutilAPublier, type EtatMeta,
} from '../mba/publication';
import { ErreurPublication, CTX_OUTILS, CTX_ACTEUR } from '../mba/appliquer-publication';
import { MetaApiError } from '../meta/errors';
import { espaceVerifie } from './scope';
import { messageDe } from '../lib/erreur';
import type { Prise, VerrousCourts } from '../db/verrous-courts';

/**
 * Publier le catalogue d'outils de l'espace chez Meta (le relais : un connecteur `EngageMe` par espace, dont les
 * outils appellent Messaging Me ; plan pur dans `src/mba/publication.ts`).
 * Deux routes : le `GET` rend le plan (la publication écrase, donc on montre quoi avant), le `POST` l'exécute. Le
 * plan est recalculé au moment d'appliquer, jamais transmis par le navigateur : Meta a pu changer entre-temps.
 */

export interface MbaPublicationDeps {
  repo: {
    /** Numéro Meta du client, résolu côté serveur. `null` = aucun numéro, donc rien à publier. */
    getTenantPhoneNumberId(tenantId: string): Promise<string | null>;
  };
  /** Le relais tel qu'il se présente à Meta. `null` = `PUBLIC_API_URL` vide : Meta ne saurait pas où appeler. */
  relais(tenantId: string): Promise<RelaisAPublier | null>;
  /** Les outils exposés au MBA, avec ce que Meta doit fournir (`src/mba/outils-a-publier.ts`). */
  outilsExposes(tenantId: string, phoneNumberId: string): Promise<OutilAPublier[]>;
  /** L'état actuel chez Meta. */
  etatMeta(tenantId: string, phoneNumberId: string): Promise<EtatMeta>;
  /**
   * Applique un geste, isolé pour rester testable sans réseau. `ctx` est partagé par toute une publication (sinon
   * la liste des connecteurs serait relue chez Meta à chaque geste) ; la route l'amorce avec les outils du plan
   * (`CTX_OUTILS`) et l'administrateur qui publie (`CTX_ACTEUR`).
   */
  appliquer(tenantId: string, phoneNumberId: string, geste: Geste, ctx: Map<string, unknown>): Promise<void>;
  /**
   * Les verrous courts partagés par les copies de l'API (`src/db/verrous-courts.ts`) : une seule publication à la
   * fois par espace, quelle que soit la copie qui la sert.
   */
  verrous: VerrousCourts;
}

/**
 * Le bail d'une publication : dix minutes. Une publication fait un appel à Meta pour lire les connecteurs, un par
 * connecteur pour lire ses outils, puis un par geste (plus une relecture des connecteurs après en avoir créé ou
 * supprimé un), en série : quelques dizaines d'appels d'environ une seconde, donc moins d'une minute pour un
 * catalogue ordinaire. Aucun de ces appels n'a de délai propre (seuls ceux d'undici, 300 s pour les en-têtes) :
 * dix minutes couvrent une publication ordinaire dix fois et un appel qui pend. Le bail est PROLONGÉ avant chaque
 * geste (`VerrousCourts.prolonger`, avec le jeton de la prise) : deux appels muets dans deux gestes différents ne le
 * font donc plus échoir, et une publication qui a perdu son verrou (échu PUIS repris par une autre copie) s'arrête
 * avant son geste suivant au lieu de publier en même temps qu'elle. Reste ouvert : un SEUL geste plus long que le bail
 * (plusieurs appels de 300 s dans le même geste). Le prix d'un bail large ne se paie que si un arrêt coupe une
 * publication en cours (l'arrêt propre laisse finir les requêtes, dans son délai) : l'espace attend alors la fin du
 * bail pour republier.
 */
export const BAIL_PUBLICATION_MS = 10 * 60_000;

/** La clé du verrou de publication d'un espace, préfixée pour ne croiser aucun autre usage des verrous courts. */
export function clePublication(tenantId: string): string {
  return `mba-publication:${tenantId}`;
}

/** Sans adresse publique, publier poserait chez Meta un connecteur qui n'appelle rien. */
const SANS_ADRESSE = 'L’adresse publique de l’API n’est pas réglée : l’agent de Meta ne saurait pas où appeler.';

export function registerMbaPublication(app: FastifyInstance, deps: MbaPublicationDeps, garde: Guard): void {
  const opts = { preHandler: garde };
  const base = '/tenants/:tenantId/mba-publication';

  /** Le plan et les outils sur lesquels il a été calculé, ou `null` quand l'adresse publique manque. */
  async function planifier(tenantId: string, pn: string): Promise<{ gestes: Geste[]; outils: OutilAPublier[] } | null> {
    const relais = await deps.relais(tenantId);
    if (relais === null) return null;
    const [outils, meta] = await Promise.all([deps.outilsExposes(tenantId, pn), deps.etatMeta(tenantId, pn)]);
    return { gestes: planifierPublication(relais, outils, meta), outils };
  }

  app.get(base, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const pn = await deps.repo.getTenantPhoneNumberId(tenant);
    if (!pn) return reply.code(200).send({ gestes: [], phoneNumberId: null });
    const plan = await planifier(tenant, pn);
    if (plan === null) return reply.code(409).send({ error: SANS_ADRESSE });
    return reply.code(200).send({ gestes: plan.gestes, phoneNumberId: pn });
  });

  /**
   * Exécute le plan, et s'arrête au premier échec en rendant ce qui a été fait : la publication étant idempotente,
   * rejouer ne refait pas ce qui a réussi.
   */
  app.post(base, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const pn = await deps.repo.getTenantPhoneNumberId(tenant);
    if (!pn) {
      return reply.code(409).send({ error: 'Aucun numéro WhatsApp connecté : il n’y a pas d’agent Meta où publier.' });
    }
    /**
     * Une seule publication à la fois par espace : deux publications simultanées posaient chacune une clé chez Meta
     * puis révoquaient l'autre, et chaque appel d'outil sortait en 401. Le verrou est en base, donc commun à toutes
     * les copies de l'API ; son jeton de garde fait qu'une publication ne relâche que SON verrou, jamais celui d'une
     * publication qui l'aurait repris après l'échéance du bail.
     */
    const prise = await deps.verrous.prendre([[clePublication(tenant), BAIL_PUBLICATION_MS]]);
    if (prise === null) {
      return reply.code(409).send({ error: 'Une publication est déjà en cours pour cet espace : attendez qu’elle se termine.' });
    }
    try {
      return await publier(tenant, pn, req.auth?.userId ?? null, reply, prise);
    } finally {
      // Un relâchement raté laisse le verrou jusqu'à la fin du bail : l'espace attend pour republier, rien de plus.
      await deps.verrous.relacher(prise).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error(`mba-publication: verrou non relâché (${tenant}):`, messageDe(err));
      });
    }
  });

  async function publier(tenant: string, pn: string, acteur: string | null, reply: FastifyReply, prise: Prise) {
    const plan = await planifier(tenant, pn);
    if (plan === null) return reply.code(409).send({ error: SANS_ADRESSE });
    const faits: Geste[] = [];
    // Vit le temps de cette publication : deux publications ne partagent jamais un état lu. Amorcée avec les outils
    // du plan et l'administrateur qui publie (l'audit des clés le nomme).
    const ctx = new Map<string, unknown>([[CTX_OUTILS, plan.outils], [CTX_ACTEUR, acteur]]);
    for (const g of plan.gestes) {
      /**
       * Le bail repart pour dix minutes avant chaque geste, et c'est aussi la preuve qu'on le tient encore : une
       * prolongation refusée (verrou repris par une autre copie) ou illisible arrête la publication, puisqu'on ne
       * peut plus garantir qu'aucune autre ne pose ses clés en même temps.
       */
      const tenu = await deps.verrous.prolonger(prise, BAIL_PUBLICATION_MS).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error(`mba-publication: verrou illisible avant « ${g.nom} » (${tenant}):`, messageDe(err));
        return false;
      });
      if (!tenu) {
        return reply.code(409).send({
          error: `La publication a perdu son verrou avant « ${g.nom} » (une autre publication a pu démarrer). ${faits.length} geste(s) déjà appliqué(s), le reste n’a pas été tenté. Relancez : ce qui a réussi ne sera pas refait.`,
          faits,
        });
      }
      try {
        await deps.appliquer(tenant, pn, g, ctx);
        faits.push(g);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`mba-publication: ${g.type} « ${g.nom} » a échoué (${tenant}):`, messageDe(err));
        // « Meta a refusé » seulement quand c'est Meta qui a répondu non ; un refus de notre part se dit tel
        // quel. Le reste est ambigu (Meta injoignable, délai dépassé, ou panne de chez nous) et se dit comme tel.
        const cause = err instanceof ErreurPublication
          ? `« ${g.nom} » : ${err.message}.`
          : err instanceof MetaApiError
            ? `Meta a refusé « ${g.nom} » (${g.type}).`
            : `« ${g.nom} » (${g.type}) n’a pas abouti (Meta injoignable, ou panne de notre côté).`;
        return reply.code(409).send({
          error: `${cause} ${faits.length} geste(s) déjà appliqué(s), le reste n’a pas été tenté. Relancez : ce qui a réussi ne sera pas refait.`,
          faits,
        });
      }
    }
    return reply.code(200).send({ faits });
  }
}
