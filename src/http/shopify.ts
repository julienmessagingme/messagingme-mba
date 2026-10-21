import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { makeJournal, type AuditSink } from '../audit/journal';
import { espaceVerifie } from './scope';
import { couperShopify, etatShopify, type DepsGestionShopify } from '../shopify/gestion';

/**
 * PARAMÈTRES > INTÉGRATIONS > SHOPIFY (plan 2026-10-21, lot 1) : une carte en lecture et « Couper » (décision de Julien).
 * Tout le réglage passe par Claude Code (les outils MCP du connecteur, `src/mcp/outils-shopify.ts`), par la MÊME gestion.
 *
 * 🔴 RÉSERVÉ AUX ADMINS, LECTURE COMPRISE (monté sous `g.admin`), comme Salesforce : brancher une boutique fait entrer
 * des données de clients dans l'espace. Le secret ne revient jamais : `lire` ne le sélectionne pas.
 *
 * ⚠️ La Base (Free) n'a pas de console : elle pilote le connecteur par les outils MCP (`get_shopify_state`,
 * `disconnect_shopify`).
 */
export interface ShopifyRouteDeps {
  gestion: DepsGestionShopify;
  audit: AuditSink;
}

const CIBLE = { kind: 'integration', id: 'shopify' };

export function registerShopify(app: FastifyInstance, deps: ShopifyRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };
  const journal = makeJournal(deps.audit);

  app.get('/tenants/:tenantId/integrations/shopify', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    return reply.code(200).send(await etatShopify(deps.gestion, tenant));
  });

  app.delete('/tenants/:tenantId/integrations/shopify', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const r = await couperShopify(deps.gestion, tenant);
    if (!r.ok) return reply.code(r.statut).send({ error: r.message });
    if (!r.valeur.dejaCoupee) await journal(tenant, req, 'shopify.coupee', CIBLE);
    return reply.code(200).send(r.valeur);
  });
}
