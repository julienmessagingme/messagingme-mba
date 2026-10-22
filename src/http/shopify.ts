import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { gardeEtendue, type Guard, type PreHandler } from '../auth/middleware';
import { makeJournal, type AuditSink } from '../audit/journal';
import { espaceVerifie } from './scope';
import {
  apercuImportClients, connecterShopify, couperShopify, etatShopify, importerClients, type DepsGestionShopify,
} from '../shopify/gestion';
import { preparerMessage, reglerMessage, type DepsPreparation } from '../shopify/preparation';

/**
 * PARAMÈTRES > INTÉGRATIONS > SHOPIFY : la carte de la console (plan 2026-10-21, lot 1 ; conception 2026-10-22). Une
 * boutique s'y branche (l'app créée à la main sur le tableau de bord de Shopify, ses deux clés collées), ses trois
 * messages s'y règlent par l'assistant, ses clients abonnés s'y importent. La MÊME gestion que les outils MCP.
 *
 * 🔴 RÉSERVÉ AUX ADMINS, LECTURE COMPRISE (monté sous `g.admin`), comme Salesforce : brancher une boutique fait entrer
 * des données de clients dans l'espace. Le secret ne revient jamais : `lire` ne le sélectionne pas. Ce qui appelle
 * Shopify ou Meta passe sous le plafond des opérations coûteuses.
 *
 * ⚠️ La Base (Free) n'a pas de console : elle pilote le connecteur par les outils MCP.
 */
export interface ShopifyRouteDeps {
  gestion: DepsGestionShopify;
  preparation: DepsPreparation;
  audit: AuditSink;
}

const CIBLE = { kind: 'integration', id: 'shopify' };

// Les corps se lisent par safeParse ; les bornes métier (domaine, clés, repères, délai) sont celles de la gestion.
const corpsBranchement = z.object({ boutique: z.string().max(200), clientId: z.string().max(300), secret: z.string().max(300) }).strict();
const corpsMessage = z.object({
  evenement: z.string().max(40), texte: z.string().max(2000), langue: z.string().max(20),
  delaiMinutes: z.number().int().optional(), consentementAffirme: z.boolean().optional(),
}).strict();
const corpsReglage = z.object({ delaiMinutes: z.number().int().optional(), consentementAffirme: z.boolean().optional() }).strict();
const corpsImport = z.object({ maximum: z.number().int() }).strict();

const raisonCorps = (e: z.ZodError): string => {
  const i = e.issues[0];
  return `${i && i.path.length > 0 ? i.path.join('.') : 'corps'} : ${i?.message ?? 'invalide'}`;
};

export function registerShopify(app: FastifyInstance, deps: ShopifyRouteDeps, garde: Guard, limiteCouteuse?: PreHandler): void {
  const opts = { preHandler: garde };
  const optsLourds = gardeEtendue(garde, limiteCouteuse);
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

  // Le branchement par la console : l'origine `console` fait abonner les webhooks par l'API.
  app.post('/tenants/:tenantId/integrations/shopify', optsLourds, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const corps = corpsBranchement.safeParse(req.body ?? {});
    if (!corps.success) return reply.code(400).send({ error: raisonCorps(corps.error) });
    const r = await connecterShopify(deps.gestion, tenant, corps.data, req.auth?.userId ?? null, 'console');
    if (!r.ok) return reply.code(r.statut).send({ error: r.message });
    await journal(tenant, req, 'shopify.branchee', CIBLE, { boutique: r.valeur.domaine, origine: 'console' });
    return reply.code(200).send(r.valeur);
  });

  app.post('/tenants/:tenantId/integrations/shopify/messages', optsLourds, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const corps = corpsMessage.safeParse(req.body ?? {});
    if (!corps.success) return reply.code(400).send({ error: raisonCorps(corps.error) });
    const r = await preparerMessage(deps.preparation, tenant, corps.data, req.auth?.userId ?? null);
    if (!r.ok) return reply.code(r.statut).send({ error: r.message });
    await journal(tenant, req, 'shopify.message', CIBLE, {
      evenement: corps.data.evenement, modele: r.valeur.modele, etat: r.valeur.etat, consentementAffirme: corps.data.consentementAffirme === true,
    });
    return reply.code(200).send(r.valeur);
  });

  app.patch('/tenants/:tenantId/integrations/shopify/messages/:evenement', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const corps = corpsReglage.safeParse(req.body ?? {});
    if (!corps.success) return reply.code(400).send({ error: raisonCorps(corps.error) });
    const { evenement } = req.params as { evenement: string };
    const r = await reglerMessage(deps.preparation, tenant, { evenement, ...corps.data }, req.auth?.userId ?? null);
    if (!r.ok) return reply.code(r.statut).send({ error: r.message });
    await journal(tenant, req, 'shopify.reglage', CIBLE, { evenement, ...corps.data });
    return reply.code(200).send(r.valeur);
  });

  app.get('/tenants/:tenantId/integrations/shopify/clients/apercu', optsLourds, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const r = await apercuImportClients(deps.gestion, tenant);
    if (!r.ok) return reply.code(r.statut).send({ error: r.message });
    return reply.code(200).send(r.valeur);
  });

  app.post('/tenants/:tenantId/integrations/shopify/clients/import', optsLourds, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const corps = corpsImport.safeParse(req.body ?? {});
    if (!corps.success) return reply.code(400).send({ error: raisonCorps(corps.error) });
    const r = await importerClients(deps.gestion, tenant, corps.data.maximum);
    if (!r.ok) return reply.code(r.statut).send({ error: r.message });
    await journal(tenant, req, 'shopify.import', CIBLE, { importes: r.valeur.importes, retablis: r.valeur.retablis });
    return reply.code(200).send(r.valeur);
  });
}
