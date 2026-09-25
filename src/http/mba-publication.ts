import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Guard } from '../auth/middleware';
import {
  planifierPublication, type Geste, type RelaisAPublier, type OutilAPublier, type EtatMeta,
} from '../mba/publication';
import { ErreurPublication, CTX_OUTILS, CTX_ACTEUR } from '../mba/appliquer-publication';
import { MetaApiError } from '../meta/errors';
import { scopeTenant } from './scope';

/**
 * Publier le catalogue d'outils de l'espace chez Meta.
 *
 * 🔴 DEUX ROUTES, ET LA PREMIÈRE N'ÉCRIT RIEN. « Engage Me fait foi, la publication écrase » est la décision
 * de Julien du 2026-09-10 : écraser n'est acceptable que si l'on montre QUOI avant de le faire. Le `GET`
 * rend le plan en toutes lettres, le `POST` l'exécute. Une publication sans aperçu serait une promesse tenue
 * dans le dos du client.
 *
 * ⚠️ LE PLAN EST RECALCULÉ AU MOMENT D'APPLIQUER, jamais transmis par le navigateur. Le lui faire porter
 * ouvrirait une fenêtre où Meta a changé entre l'aperçu et le clic, et où l'on exécuterait des gestes
 * calculés sur un état périmé, en croyant montrer ce qu'on allait faire.
 *
 * 🔴 DEPUIS LE 2026-09-21, CE QUI PART EST LE RELAIS (spec 2026-09-21-relais-mba-design.md) : un connecteur
 * `EngageMe` par espace, dont les outils appellent Engage Me. Le plan pur vit dans `src/mba/publication.ts`.
 */

export interface MbaPublicationDeps {
  /** Numéro Meta du client, résolu côté serveur. `null` = aucun numéro, donc rien à publier. */
  numeroDuTenant(tenantId: string): Promise<string | null>;
  /** Le relais tel qu'il se présente à Meta. `null` = `PUBLIC_API_URL` vide : Meta ne saurait pas où appeler. */
  relais(tenantId: string): Promise<RelaisAPublier | null>;
  /** Les outils EXPOSÉS au MBA, avec ce que Meta doit fournir (`src/mba/outils-a-publier.ts`). */
  outilsExposes(tenantId: string, phoneNumberId: string): Promise<OutilAPublier[]>;
  /** L'état actuel chez Meta. */
  etatMeta(tenantId: string, phoneNumberId: string): Promise<EtatMeta>;
  /**
   * Applique UN geste. Isolé pour rester testable sans réseau.
   *
   * ⚠️ `ctx` EST UN BAC À MÉMOIRE PARTAGÉ PAR TOUTE UNE PUBLICATION, et il n'est pas décoratif : sans lui,
   * l'implémentation relisait la liste des connecteurs CHEZ META à chaque geste. La route l'AMORCE avec les
   * outils du plan de cette publication (`CTX_OUTILS`) et l'administrateur qui publie (`CTX_ACTEUR`).
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
   * 🔴 UNE SEULE PUBLICATION À LA FOIS PAR ESPACE (revue finale du 2026-09-21). Deux publications simultanées
   * posaient chacune une clé chez Meta puis révoquaient « toutes les autres », donc celle de l'autre : Meta se
   * retrouvait avec une clé révoquée, chaque appel d'outil sortait en 401, et les deux POST rendaient 200.
   * Des clics multiples ont DÉJÀ eu lieu en production (le 2026-09-18).
   *
   * ⚠️ VERROU LOCAL AU PROCESS, comme les plafonds de débit : il suffit tant que l'API tourne en UNE instance.
   * Le passer en base (bail, sur le modèle de `src/campaign/run-lock.ts`) avant tout multi-réplica (`todo.md`).
   */
  const enCours = new Set<string>();

  app.get(base, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'espace interdit' });
    const pn = await deps.numeroDuTenant(tenant);
    if (!pn) return reply.code(200).send({ gestes: [], phoneNumberId: null });
    const plan = await planifier(tenant, pn);
    if (plan === null) return reply.code(409).send({ error: SANS_ADRESSE });
    return reply.code(200).send({ gestes: plan.gestes, phoneNumberId: pn });
  });

  /**
   * Exécute le plan.
   *
   * 🔴 ON S'ARRÊTE AU PREMIER ÉCHEC, et on rend ce qui a été fait. Continuer laisserait un état à moitié
   * publié dont personne ne connaîtrait la forme ; s'arrêter en le disant permet de rejouer, et la
   * publication étant IDEMPOTENTE, rejouer ne refait pas ce qui a réussi.
   */
  app.post(base, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'espace interdit' });
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
    // Vit le temps de CETTE publication, et meurt avec elle : deux publications ne partagent jamais un état
    // lu, ce qui serait précisément la façon d'agir sur une photo périmée. Amorcée avec les outils sur lesquels
    // le plan de CETTE publication a été calculé, et l'administrateur qui publie (l'audit des clés le nomme).
    const ctx = new Map<string, unknown>([[CTX_OUTILS, plan.outils], [CTX_ACTEUR, acteur]]);
    for (const g of plan.gestes) {
      try {
        await deps.appliquer(tenant, pn, g, ctx);
        faits.push(g);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`mba-publication: ${g.type} « ${g.nom} » a échoué (${tenant}):`, err instanceof Error ? err.message : err);
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
