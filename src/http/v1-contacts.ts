import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Guard } from '../auth/middleware';
import { raisonDeValidation } from '../api/contacts-upsert';
import {
  schemaContactLotV1, schemaContactV1, schemaPatchContactV1, schemaRechercheContactV1,
  type ContactV1, type ResultatFiche, type ServiceContactsV1,
} from '../api/contacts-v1';
import { refuser, STATUT_PAR_CODE } from '../api/erreurs';
import { compterOuRefuser, type ApiUsageGuard } from '../api/usage-guard';

export interface V1ContactsRouteDeps extends ServiceContactsV1 {
  /**
   * Le garde d'usage. Requis : optionnel, il manquerait un jour à une route et son compteur disparaîtrait sans bruit.
   */
  usage: ApiUsageGuard;
}

/** Les deux gardes : lire une fiche n'est pas écrire, et une clé ne porte que ce qu'on lui a donné. */
export interface GardesContactsV1 {
  ecrire: Guard;
  lire: Guard;
}

/**
 * 50 fiches par lot : un lot occupe l'unique place d'opération lourde du process (`API_MAX_LOURDES_SIMULTANEES`),
 * partagée par tous les espaces et `/v1/sends`, et sa taille décide combien de temps il la garde. Les gros volumes
 * passent par l'import CSV de la console.
 */
export const MAX_BATCH = 50;
export const conteneurDuLot = z.object({ contacts: z.array(z.unknown()) });

/**
 * Le tri du lot : les éléments bien formés d'un côté, les refus de l'autre, avec leur index.
 * L'index rendu est celui du corps envoyé, jamais celui de la liste filtrée : sinon l'erreur de la ligne 3
 * serait rendue sur la ligne 1. Un élément refusé ne fait pas tomber le lot ; seul un conteneur malformé rend 400.
 * Les bornes d'une fiche de lot sont plus serrées qu'à l'unité : `schemaContactLotV1`, jamais `schemaContactV1`.
 */
function trierLeLot(bruts: unknown[]): { valides: Array<{ index: number; contact: ContactV1 }>; refus: ResultatFiche[] } {
  const valides: Array<{ index: number; contact: ContactV1 }> = [];
  const refus: ResultatFiche[] = [];
  bruts.forEach((brut, index) => {
    const r = schemaContactLotV1.safeParse(brut);
    if (r.success) valides.push({ index, contact: r.data });
    else refus.push({ index, status: 'error', code: 'invalid_body', reason: raisonDeValidation(r.error) });
  });
  return { valides, refus };
}

/**
 * Les routes publiques des fiches. L'espace vient de `req.auth`, posé par la garde de clé : aucun `:tenantId`
 * dans l'adresse. Toute erreur a la forme `{ error, code }`. `PATCH` compte sous `contacts.upsert` (une fiche).
 */
export function registerV1Contacts(app: FastifyInstance, deps: V1ContactsRouteDeps, gardes: GardesContactsV1): void {
  const ecrire = { preHandler: gardes.ecrire };
  const lire = { preHandler: gardes.lire };

  app.post('/v1/contacts', ecrire, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    /** La même validation que le lot, pas une variante. */
    const valide = schemaContactV1.safeParse(req.body);
    if (!valide.success) return refuser(reply, 400, 'invalid_body', raisonDeValidation(valide.error));
    if (!await compterOuRefuser(deps.usage, req, reply, 'contacts.upsert')) return reply;
    const [r] = await deps.ecrireFiches(req.auth.tenantId, [valide.data]);
    // Un seul élément entré, donc un seul résultat : son absence serait un défaut du service, pas un cas métier.
    if (!r) throw new Error('ecrireFiches : aucun résultat pour un élément');
    if (r.status === 'error') return refuser(reply, STATUT_PAR_CODE[r.code] ?? 400, r.code, r.reason);
    return reply.code(200).send({ contactId: r.contactId, status: r.status });
  });

  app.post('/v1/contacts/batch', ecrire, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    const conteneur = conteneurDuLot.safeParse(req.body);
    if (!conteneur.success || conteneur.data.contacts.length === 0) {
      return refuser(reply, 400, 'invalid_body', '« contacts » : un tableau non vide est attendu');
    }
    const bruts = conteneur.data.contacts;
    if (bruts.length > MAX_BATCH) return refuser(reply, 400, 'invalid_body', `« contacts » : ${MAX_BATCH} éléments au plus par lot`);
    /**
     * Le travail est compté sur ce que l'appelant demande, pas sur ce qui survit à la validation : sinon une boucle
     * de corps invalides serait invisible des compteurs.
     */
    if (!await compterOuRefuser(deps.usage, req, reply, 'contacts.batch', bruts.length)) return reply;

    const { valides, refus } = trierLeLot(bruts);
    const ecrits = valides.length === 0
      ? []
      : (await deps.ecrireFiches(req.auth.tenantId, valides.map((v) => v.contact)))
        // Le service numérote sa liste : on reporte chaque résultat sur l'index d'origine.
        .map((r) => ({ ...r, index: valides[r.index]?.index ?? r.index }));
    const results = [...refus, ...ecrits].sort((a, b) => a.index - b.index);
    const created = results.filter((r) => r.status === 'created').length;
    const updated = results.filter((r) => r.status === 'updated').length;
    // Les refus de validation comptent dans `errors`, comme ceux du service : un seul compteur pour l'intégrateur.
    const errors = results.filter((r) => r.status === 'error').length;
    return reply.code(200).send({ results, created, updated, errors });
  });

  /**
   * 🔴 Le numéro voyage dans le corps, jamais dans l'adresse : `/v1/contacts/+33…` finirait dans les journaux
   * d'accès du proxy et de Cloudflare.
   */
  app.post('/v1/contacts/search', lire, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    const valide = schemaRechercheContactV1.safeParse(req.body);
    if (!valide.success) return refuser(reply, 400, 'invalid_body', raisonDeValidation(valide.error));
    if (!await compterOuRefuser(deps.usage, req, reply, 'contacts.read')) return reply;
    const r = await deps.chercherFiche(req.auth.tenantId, valide.data);
    if (!r.ok) return refuser(reply, 400, r.code, r.reason);
    return reply.code(200).send({ contact: r.fiche });
  });

  app.get<{ Params: { contactId: string } }>('/v1/contacts/:contactId', lire, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    if (!await compterOuRefuser(deps.usage, req, reply, 'contacts.read')) return reply;
    const fiche = await deps.lireFiche(req.auth.tenantId, req.params.contactId);
    if (!fiche) return refuser(reply, 404, 'unknown_contact', 'fiche inconnue');
    return reply.code(200).send(fiche);
  });

  app.patch<{ Params: { contactId: string } }>('/v1/contacts/:contactId', ecrire, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    const valide = schemaPatchContactV1.safeParse(req.body ?? {});
    if (!valide.success) return refuser(reply, 400, 'invalid_body', raisonDeValidation(valide.error));
    if (!await compterOuRefuser(deps.usage, req, reply, 'contacts.upsert')) return reply;
    const r = await deps.modifierFiche(req.auth.tenantId, req.params.contactId, valide.data);
    if (!r.ok) return refuser(reply, STATUT_PAR_CODE[r.code] ?? 400, r.code, r.reason);
    return reply.code(200).send({ contactId: r.contactId });
  });
}
