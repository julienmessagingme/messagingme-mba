import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Guard } from '../auth/middleware';
import {
  planifierPublication, type Geste, type RelaisAPublier, type OutilAPublier, type EtatMeta,
} from '../mba/publication';
import { ErreurPublication, CTX_OUTILS, CTX_ACTEUR } from '../mba/appliquer-publication';
import { MetaApiError } from '../meta/errors';
import { espaceVerifie } from './scope';
import { messageDe } from '../lib/erreur';

/**
 * Publier le catalogue d'outils de l'espace chez Meta (le relais : un connecteur `EngageMe` par espace, dont les
 * outils appellent Engage Me ; plan pur dans `src/mba/publication.ts`).
 * Deux routes : le `GET` rend le plan (la publication écrase, donc on montre quoi avant), le `POST` l'exécute. Le
 * plan est recalculé au moment d'appliquer, jamais transmis par le navigateur : Meta a pu changer entre-temps.
 */

export interface MbaPublicationDeps {
  /** Numéro Meta du client, résolu côté serveur. `null` = aucun numéro, donc rien à publier. */
  numeroDuTenant(tenantId: string): Promise<string | null>;
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

  /**
   * Une seule publication à la fois par espace : deux publications simultanées posaient chacune une clé chez Meta
   * puis révoquaient l'autre, et chaque appel d'outil sortait en 401. Verrou local au process : suffisant tant que
   * l'API tourne en une instance, à passer en base (bail, cf. `src/campaign/run-lock.ts`) avant tout multi-réplica.
   */
  const enCours = new Set<string>();

  app.get(base, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const pn = await deps.numeroDuTenant(tenant);
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
    const pn = await deps.numeroDuTenant(tenant);
    if (!pn) {
      return reply.code(409).send({ error: 'Aucun numéro WhatsApp connecté : il n’y a pas d’agent Meta où publier.' });
    }
    if (enCours.has(tenant)) {
      return reply.code(409).send({ error: 'Une publication est déjà en cours pour cet espace : attendez qu’elle se termine.' });
    }
    enCours.add(tenant);
    try {
      return await publier(tenant, pn, req.auth?.userId ?? null, reply);
    } finally {
      enCours.delete(tenant);
    }
  });

  async function publier(tenant: string, pn: string, acteur: string | null, reply: FastifyReply) {
    const plan = await planifier(tenant, pn);
    if (plan === null) return reply.code(409).send({ error: SANS_ADRESSE });
    const faits: Geste[] = [];
    // Vit le temps de cette publication : deux publications ne partagent jamais un état lu. Amorcée avec les outils
    // du plan et l'administrateur qui publie (l'audit des clés le nomme).
    const ctx = new Map<string, unknown>([[CTX_OUTILS, plan.outils], [CTX_ACTEUR, acteur]]);
    for (const g of plan.gestes) {
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
