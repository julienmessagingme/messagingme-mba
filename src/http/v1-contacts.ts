import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { raisonDeValidation, schemaContactApi } from '../api/contacts-upsert';
import type { ApiContactInput, ApiUpsertOutcome } from '../api/contacts-upsert';

export interface V1ContactsRouteDeps {
  /** Upsert d'un lot de contacts (tenant issu de la clé d'API). Renvoie un outcome par item. */
  upsertContacts(tenantId: string, items: ApiContactInput[]): Promise<ApiUpsertOutcome[]>;
}

const MAX_BATCH = 500;

/**
 * LE TRI DU LOT : ce qui est bien formé d'un côté, ce qui ne l'est pas de l'autre, AVEC SON INDEX.
 *
 * 🔴 L'INDEX RENDU EST CELUI DU CORPS ENVOYÉ, jamais celui de la liste filtrée, et c'est le seul
 * point délicat de cette validation. Le service numérote ce qu'IL reçoit : sans ce report, l'erreur de la
 * ligne 3 serait rendue sur la ligne 1, et l'intégrateur corrigerait un contact parfaitement valide.
 *
 * 🔴 ET UN ÉLÉMENT REFUSÉ NE FAIT PAS TOMBER LE LOT : c'est le contrat du batch depuis toujours (un
 * lot de 500 dont la ligne 37 est fausse écrit 499 contacts), et la validation ne doit pas le changer.
 * Seul un CONTENEUR malformé rend 400.
 */
function trierLeLot(bruts: unknown[]): { valides: Array<{ index: number; contact: ApiContactInput }>; refus: ApiUpsertOutcome[] } {
  const valides: Array<{ index: number; contact: ApiContactInput }> = [];
  const refus: ApiUpsertOutcome[] = [];
  bruts.forEach((brut, index) => {
    const r = schemaContactApi.safeParse(brut);
    if (r.success) valides.push({ index, contact: r.data });
    else refus.push({ index, status: 'error', reason: raisonDeValidation(r.error) });
  });
  return { valides, refus };
}

/**
 * Routes publiques /v1 des contacts. Le tenant vient à 100% de `req.auth` (posé par makeRequireApiKey via le
 * guard) — pas d'`:tenantId` dans l'URL. Guard attendu : [makeRequireApiKey, requireScope('contacts:write')].
 */
export function registerV1Contacts(app: FastifyInstance, deps: V1ContactsRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};

  app.post('/v1/contacts', opts, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'clé d’API requise' });
    /**
     * ⚠️ LA MÊME VALIDATION QUE LE BATCH, ET PAS UNE VARIANTE. Cette route ne contrôlait que la présence
     * de `phone` avant de caster : `fields` en chaîne y créait donc un champ personnalisé par caractère,
     * exactement comme dans le batch. Fermer une porte en laissant l'autre ouverte est le motif « une
     * capacité câblée sur un consommateur sur deux », déjà payé plusieurs fois dans ce dépôt.
     */
    const valide = schemaContactApi.safeParse(req.body);
    if (!valide.success) return reply.code(400).send({ error: raisonDeValidation(valide.error) });
    const [outcome] = await deps.upsertContacts(req.auth.tenantId, [valide.data]);
    if (!outcome || outcome.status === 'error') return reply.code(400).send({ error: outcome?.reason ?? 'échec' });
    return reply.code(200).send({ contactId: outcome.contactId, status: outcome.status });
  });

  app.post('/v1/contacts/batch', opts, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'clé d’API requise' });
    const body = req.body as { contacts?: unknown };
    if (!Array.isArray(body?.contacts) || body.contacts.length === 0) return reply.code(400).send({ error: 'contacts (tableau non vide) requis' });
    if (body.contacts.length > MAX_BATCH) return reply.code(400).send({ error: `maximum ${MAX_BATCH} contacts par lot` });

    const { valides, refus } = trierLeLot(body.contacts);
    const ecrits = valides.length === 0
      ? []
      : (await deps.upsertContacts(req.auth.tenantId, valides.map((v) => v.contact)))
        // Le service numérote SA liste : on reporte chaque résultat sur l'index d'origine.
        .map((r) => ({ ...r, index: valides[r.index]?.index ?? r.index }));

    const results = [...refus, ...ecrits].sort((a, b) => a.index - b.index);
    const created = results.filter((r) => r.status === 'created').length;
    const updated = results.filter((r) => r.status === 'updated').length;
    // ⚠️ LES REFUS DE VALIDATION COMPTENT DANS `errors`, comme les échecs d'écriture : c'est un seul
    // compteur pour l'intégrateur, qui ne sait pas (et n'a pas à savoir) où le refus a été décidé.
    const errors = results.filter((r) => r.status === 'error').length;
    return reply.code(200).send({ results, created, updated, errors });
  });
}
