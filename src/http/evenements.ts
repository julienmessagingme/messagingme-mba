import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Guard, PreHandler } from '../auth/middleware';
import { gardeEtendue } from '../auth/middleware';
import { makeJournal, type AuditSink } from '../audit/journal';
import { corpsDuRefus, type Refus } from '../lib/issue';
import { espaceVerifie } from './scope';
import { TYPES_ABONNABLES } from '../evenements/types';
import {
  TYPES_PAR_DEFAUT, creerAdresse, envoyerEssai, lireJournal, modifierAdresse, rejouerEchecs, rejouerEnvoi, supprimerAdresse,
  tournerSecret, type DepsGestionEvenements,
} from '../evenements/gestion';

/**
 * Développeurs > Webhooks sortants (lot 12, livraison A) : les adresses de l'application d'un client, leur secret, leur
 * journal. Toute la logique vit dans `src/evenements/gestion.ts`, partagée avec les outils MCP.
 *
 * 🔴 Réservé aux admins, lecture comprise (monté sous `g.admin`) : le journal porte le corps des événements, donc des
 * numéros et des messages de contacts. 🔴 Le secret n'est rendu qu'à la création et à la rotation, jamais relu, jamais
 * écrit dans l'audit. L'essai et le rejeu en masse appellent ou relancent beaucoup : sous le plafond des routes coûteuses.
 */
export interface EvenementsRouteDeps {
  gestion: DepsGestionEvenements;
  audit: AuditSink;
}

const CIBLE = (id: string) => ({ kind: 'adresse_evenements', id });

export function registerEvenements(app: FastifyInstance, deps: EvenementsRouteDeps, garde: Guard, limiteCouteuse?: PreHandler): void {
  const opts = { preHandler: garde };
  const optsLourds = gardeEtendue(garde, limiteCouteuse);
  const journal = makeJournal(deps.audit);
  const g = deps.gestion;
  const refuser = (reply: FastifyReply, r: Refus) => reply.code(r.statut).send(corpsDuRefus(r));

  app.get('/tenants/:tenantId/evenements/adresses', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    return reply.code(200).send({
      adresses: await g.adresses.lister(tenant),
      limite: await g.limiteAdresses(tenant),
      types: TYPES_ABONNABLES,
      typesParDefaut: TYPES_PAR_DEFAUT,
      chiffrementPret: g.chiffrementPret,
    });
  });

  app.post('/tenants/:tenantId/evenements/adresses', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const r = await creerAdresse(g, tenant, req.body);
    if (!r.ok) return refuser(reply, r);
    await journal(tenant, req, 'evenements.adresse_creee', CIBLE(r.valeur.adresse.id), { url: r.valeur.adresse.url, types: r.valeur.adresse.types });
    return reply.code(201).send(r.valeur);
  });

  app.patch<{ Params: { adresseId: string } }>('/tenants/:tenantId/evenements/adresses/:adresseId', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const r = await modifierAdresse(g, tenant, req.params.adresseId, req.body);
    if (!r.ok) return refuser(reply, r);
    await journal(tenant, req, 'evenements.adresse_modifiee', CIBLE(r.valeur.id), { active: r.valeur.active, types: r.valeur.types });
    return reply.code(200).send(r.valeur);
  });

  app.post<{ Params: { adresseId: string } }>('/tenants/:tenantId/evenements/adresses/:adresseId/rotation', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const r = await tournerSecret(g, tenant, req.params.adresseId);
    if (!r.ok) return refuser(reply, r);
    await journal(tenant, req, 'evenements.secret_tourne', CIBLE(req.params.adresseId), { ancienJusqua: r.valeur.ancienJusqua });
    return reply.code(200).send(r.valeur);
  });

  app.delete<{ Params: { adresseId: string } }>('/tenants/:tenantId/evenements/adresses/:adresseId', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const r = await supprimerAdresse(g, tenant, req.params.adresseId);
    if (!r.ok) return refuser(reply, r);
    await journal(tenant, req, 'evenements.adresse_supprimee', CIBLE(req.params.adresseId));
    return reply.code(204).send();
  });

  app.post<{ Params: { adresseId: string } }>('/tenants/:tenantId/evenements/adresses/:adresseId/essai', optsLourds, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const r = await envoyerEssai(g, tenant, req.params.adresseId);
    return r.ok ? reply.code(200).send(r.valeur) : refuser(reply, r);
  });

  app.get<{ Params: { adresseId: string }; Querystring: { avant?: string; limite?: string } }>(
    '/tenants/:tenantId/evenements/adresses/:adresseId/envois', opts, async (req, reply) => {
      const tenant = espaceVerifie(req);
      const r = await lireJournal(g, tenant, req.params.adresseId, { avant: req.query.avant, limite: req.query.limite });
      return r.ok ? reply.code(200).send({ envois: r.valeur }) : refuser(reply, r);
    },
  );

  app.post<{ Params: { envoiId: string } }>('/tenants/:tenantId/evenements/envois/:envoiId/rejeu', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const r = await rejouerEnvoi(g, tenant, req.params.envoiId);
    return r.ok ? reply.code(202).send({ rejoue: true }) : refuser(reply, r);
  });

  app.post<{ Params: { adresseId: string } }>('/tenants/:tenantId/evenements/adresses/:adresseId/rejeu-echecs', optsLourds, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const r = await rejouerEchecs(g, tenant, req.params.adresseId, req.body);
    return r.ok ? reply.code(202).send(r.valeur) : refuser(reply, r);
  });
}
