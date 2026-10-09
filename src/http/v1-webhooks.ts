import { z } from 'zod';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Guard } from '../auth/middleware';
import type { AuditSink } from '../audit/journal';
import { journalDeLApi } from '../api/journal-api';
import { refuser, type CodeApi } from '../api/erreurs';
import { messageDeForme } from '../api/forme';
import { compterOuRefuser, type ApiUsageGuard } from '../api/usage-guard';
import type { Refus } from '../lib/issue';
import { MESSAGE_OPERATIONS_LOURDES, type PlafondPartage } from '../auth/plafond-partage';
import { TYPES_ABONNABLES } from '../evenements/types';
import type { AdresseVue, EnvoiVue } from '../evenements/store.pg';
import {
  JOURNAL_PAGE_MAX, TYPES_PAR_DEFAUT, creerAdresse, envoyerEssai, lireJournal, modifierAdresse, rejouerEchecs, rejouerEnvoi,
  supprimerAdresse, tournerSecret, type DepsGestionEvenements,
} from '../evenements/gestion';

/**
 * LES WEBHOOKS SORTANTS PAR L'API (lot 13, domaine 4, spec § 6) : les adresses de l'application d'un client, leur secret,
 * leur journal, gérés par une clé. 🔴 Aucune logique ici : ce sont les fonctions de `src/evenements/gestion.ts`, celles
 * de la console et des outils MCP du lot 12 (même saisie, mêmes contrôles d'adresse, même limite de l'offre, secret
 * montré une seule fois). La route traduit les noms (anglais, comme le reste de `/v1`) et les refus (codes de l'API).
 *
 * Garde attendue : `[makeRequireApiKey, requireScope('webhooks:write')]`, un droit NEUF sans reprise : il couvre aussi
 * la lecture, le journal portant le corps des événements, donc des numéros et des messages de contacts. L'espace vient
 * de `req.auth`, jamais de l'URL.
 */
export interface V1WebhooksRouteDeps {
  usage: ApiUsageGuard;
  /** La gestion de la console, le MÊME objet (`src/index.ts`). */
  gestion: DepsGestionEvenements;
  audit: AuditSink;
  /**
   * Le plafond des opérations coûteuses de la console (par espace), posé par `buildServer` au montage : l'essai appelle
   * l'application du client (jusqu'à 10 s), le rejeu en masse relance jusqu'à 500 envois. La console les y soumet.
   */
  couteux: Pick<PlafondPartage, 'consommer'>;
}

/** Une adresse, telle que l'API la rend. */
export interface WebhookV1 {
  id: string;
  url: string;
  description: string;
  types: string[];
  active: boolean;
  createdAt: string;
  /** Fin de la fenêtre où l'ancien secret signe encore après une rotation, `null` sans rotation en cours. */
  previousSecretValidUntil: string | null;
  lastDeliveredAt: string | null;
  /** Envois qui ont échoué au moins une fois et se réessaient encore. */
  retrying: number;
  /** Envois abandonnés (24 h d'échecs, 410, adresse en pause ou au-delà de l'offre). */
  failed: number;
}

/** Un envoi du journal, tel que l'API le rend. `body` est le corps envoyé, octet pour octet. */
export interface DeliveryV1 {
  id: string;
  eventId: string;
  type: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  lastStatusCode: number | null;
  lastResponse: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  deliveredAt: string | null;
  body: string;
}

export const webhookV1 = (a: AdresseVue): WebhookV1 => ({
  id: a.id, url: a.url, description: a.description, types: a.types, active: a.active, createdAt: a.creeLe,
  previousSecretValidUntil: a.ancienSecretJusqua, lastDeliveredAt: a.derniereLivraisonLe, retrying: a.enReessai, failed: a.echecs,
});

const STATUT_PUBLIC: Readonly<Record<EnvoiVue['statut'], DeliveryV1['status']>> = { en_cours: 'pending', livre: 'delivered', echec: 'failed' };

export const deliveryV1 = (e: EnvoiVue): DeliveryV1 => ({
  id: e.id, eventId: e.evenementId, type: e.type, status: STATUT_PUBLIC[e.statut], attempts: e.tentatives,
  lastStatusCode: e.dernierCode, lastResponse: e.derniereReponse, nextAttemptAt: e.prochainEssaiLe, createdAt: e.creeLe,
  deliveredAt: e.livreLe, body: e.corps,
});

/**
 * Un refus de la gestion, sous un code de l'API. Le 402 de l'offre garde son corps entier (`limite`, `max`,
 * `upgradeUrl`), comme les autres refus d'offre de `/v1`.
 */
function refuserGestion(reply: FastifyReply, r: Refus, objet: 'webhook' | 'delivery'): FastifyReply {
  if (r.statut === 402) return reply.code(402).send({ error: r.erreur, ...r.details });
  const code: CodeApi = r.statut === 400 ? 'invalid_body'
    : r.statut === 404 ? (objet === 'delivery' ? 'delivery_not_found' : 'webhook_not_found')
      : r.statut === 409 ? 'delivery_not_replayable'
        : 'webhooks_unavailable';
  return refuser(reply, r.statut, code, r.erreur);
}

const CIBLE = (id: string) => ({ kind: 'adresse_evenements', id });
const parametresAdresse = z.object({ webhookId: z.string().max(100) });
const parametresEnvoi = z.object({ deliveryId: z.string().max(100) });
const requeteJournal = z.strictObject({
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(JOURNAL_PAGE_MAX).optional(),
});
export const corpsRejeu = z.strictObject({ since: z.string().datetime({ offset: true }) });

export function registerV1Webhooks(app: FastifyInstance, deps: V1WebhooksRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };
  // Pas `makeJournal` : derrière une clé, l'acteur n'est pas un compte (`src/api/journal-api.ts`).
  const journal = journalDeLApi(deps.audit);
  const g = deps.gestion;
  const lecture = (req: Parameters<typeof compterOuRefuser>[1], reply: FastifyReply) => compterOuRefuser(deps.usage, req, reply, 'webhooks.read');
  const ecriture = (req: Parameters<typeof compterOuRefuser>[1], reply: FastifyReply) => compterOuRefuser(deps.usage, req, reply, 'webhooks.write');
  /** Le plafond coûteux : `true` si l'opération passe, sinon le 429 est rendu avec son `Retry-After`. */
  const lourde = async (tenantId: string, reply: FastifyReply): Promise<boolean> => {
    const c = await deps.couteux.consommer(tenantId);
    if (c.accepte) return true;
    reply.header('retry-after', String(Math.max(1, Math.ceil(c.attenteMs / 1000))));
    await refuser(reply, 429, 'rate_limited', MESSAGE_OPERATIONS_LOURDES);
    return false;
  };
  const adresseDe = (params: unknown): string => {
    const p = parametresAdresse.safeParse(params);
    return p.success ? p.data.webhookId : '';
  };

  app.get('/v1/webhooks', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    if (!await lecture(req, reply)) return reply;
    const t = req.auth.tenantId;
    return reply.code(200).send({
      data: (await g.adresses.lister(t)).map(webhookV1),
      limit: await g.limiteAdresses(t),
      types: TYPES_ABONNABLES,
      defaultTypes: TYPES_PAR_DEFAUT,
    });
  });

  app.post('/v1/webhooks', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    if (!await ecriture(req, reply)) return reply;
    const t = req.auth.tenantId;
    const r = await creerAdresse(g, t, req.body);
    if (!r.ok) return refuserGestion(reply, r, 'webhook');
    await journal(t, req, 'evenements.adresse_creee', CIBLE(r.valeur.adresse.id), { url: r.valeur.adresse.url, types: r.valeur.adresse.types, via: 'api' });
    // 🔴 Le secret n'est rendu qu'ici et à la rotation : il ne se relit jamais.
    return reply.code(201).send({ webhook: webhookV1(r.valeur.adresse), secret: r.valeur.secret });
  });

  app.get('/v1/webhooks/:webhookId', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    if (!await lecture(req, reply)) return reply;
    const id = adresseDe(req.params);
    const a = (await g.adresses.lister(req.auth.tenantId)).find((x) => x.id === id);
    if (!a) return refuser(reply, 404, 'webhook_not_found', 'Adresse introuvable.');
    return reply.code(200).send(webhookV1(a));
  });

  app.patch('/v1/webhooks/:webhookId', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    if (!await ecriture(req, reply)) return reply;
    const t = req.auth.tenantId;
    const r = await modifierAdresse(g, t, adresseDe(req.params), req.body);
    if (!r.ok) return refuserGestion(reply, r, 'webhook');
    await journal(t, req, 'evenements.adresse_modifiee', CIBLE(r.valeur.id), { active: r.valeur.active, types: r.valeur.types, via: 'api' });
    return reply.code(200).send(webhookV1(r.valeur));
  });

  app.post('/v1/webhooks/:webhookId/rotate-secret', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    if (!await ecriture(req, reply)) return reply;
    const t = req.auth.tenantId;
    const id = adresseDe(req.params);
    const r = await tournerSecret(g, t, id);
    if (!r.ok) return refuserGestion(reply, r, 'webhook');
    await journal(t, req, 'evenements.secret_tourne', CIBLE(id), { ancienJusqua: r.valeur.ancienJusqua, via: 'api' });
    return reply.code(200).send({ secret: r.valeur.secret, previousSecretValidUntil: r.valeur.ancienJusqua });
  });

  app.delete('/v1/webhooks/:webhookId', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    if (!await ecriture(req, reply)) return reply;
    const t = req.auth.tenantId;
    const id = adresseDe(req.params);
    const r = await supprimerAdresse(g, t, id);
    if (!r.ok) return refuserGestion(reply, r, 'webhook');
    await journal(t, req, 'evenements.adresse_supprimee', CIBLE(id), { via: 'api' });
    return reply.code(204).send();
  });

  app.post('/v1/webhooks/:webhookId/test', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    if (!await ecriture(req, reply)) return reply;
    if (!await lourde(req.auth.tenantId, reply)) return reply;
    const r = await envoyerEssai(g, req.auth.tenantId, adresseDe(req.params));
    if (!r.ok) return refuserGestion(reply, r, 'webhook');
    return reply.code(200).send({ eventId: r.valeur.evenementId, delivered: r.valeur.livre, statusCode: r.valeur.code, response: r.valeur.reponse });
  });

  app.get('/v1/webhooks/:webhookId/deliveries', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    if (!await lecture(req, reply)) return reply;
    const q = requeteJournal.safeParse(req.query);
    if (!q.success) return refuser(reply, 400, 'invalid_body', messageDeForme(q.error));
    const limite = q.data.limit ?? 50;
    const r = await lireJournal(g, req.auth.tenantId, adresseDe(req.params), { avant: q.data.before, limite: String(limite) });
    if (!r.ok) return refuserGestion(reply, r, 'webhook');
    const data = r.valeur.map(deliveryV1);
    // La page suivante commence avant le dernier rendu, quand la page est pleine.
    const nextBefore = data.length === limite ? data[data.length - 1]!.createdAt : null;
    return reply.code(200).send({ data, nextBefore });
  });

  app.post('/v1/webhooks/deliveries/:deliveryId/replay', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    if (!await ecriture(req, reply)) return reply;
    const p = parametresEnvoi.safeParse(req.params);
    const r = await rejouerEnvoi(g, req.auth.tenantId, p.success ? p.data.deliveryId : '');
    if (!r.ok) return refuserGestion(reply, r, 'delivery');
    return reply.code(202).send({ replayed: true });
  });

  app.post('/v1/webhooks/:webhookId/replay-failures', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    if (!await ecriture(req, reply)) return reply;
    const lu = corpsRejeu.safeParse(req.body ?? {});
    if (!lu.success) return refuser(reply, 400, 'invalid_body', messageDeForme(lu.error));
    if (!await lourde(req.auth.tenantId, reply)) return reply;
    const r = await rejouerEchecs(g, req.auth.tenantId, adresseDe(req.params), { depuis: lu.data.since });
    if (!r.ok) return refuserGestion(reply, r, 'webhook');
    return reply.code(202).send({ replayed: r.valeur.rejoues });
  });
}
