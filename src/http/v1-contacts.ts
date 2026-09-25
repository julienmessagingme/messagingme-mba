import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Guard } from '../auth/middleware';
import { raisonDeValidation } from '../api/contacts-upsert';
import {
  schemaContactV1, schemaPatchContactV1, schemaRechercheContactV1,
  type ContactV1, type ResultatFiche, type ServiceContactsV1,
} from '../api/contacts-v1';
import { refuser, STATUT_PAR_CODE } from '../api/erreurs';
import { compterOuRefuser, type ApiUsageGuard } from '../api/usage-guard';

export interface V1ContactsRouteDeps extends ServiceContactsV1 {
  /**
   * Le garde d'usage, injecté au bootstrap.
   *
   * 🔴 OBLIGATOIRE, comme le pré-filtre des clés : optionnel, il manquerait un jour à une route et le
   * compteur de cette route disparaîtrait sans bruit. Ce qu'on veut voir est précisément ce qu'on oublie.
   */
  usage: ApiUsageGuard;
}

/** Les DEUX gardes : lire une fiche n'est pas écrire, et une clé ne porte que ce qu'on lui a donné. */
export interface GardesContactsV1 {
  ecrire: Guard;
  lire: Guard;
}

export const MAX_BATCH = 500;
export const conteneurDuLot = z.object({ contacts: z.array(z.unknown()) });

/**
 * LE TRI DU LOT : ce qui est bien formé d'un côté, ce qui ne l'est pas de l'autre, AVEC SON INDEX.
 *
 * 🔴 L'INDEX RENDU EST CELUI DU CORPS ENVOYÉ, jamais celui de la liste filtrée : le service numérote ce
 * qu'IL reçoit, et sans ce report l'erreur de la ligne 3 serait rendue sur la ligne 1, et l'intégrateur
 * corrigerait un contact parfaitement valide.
 *
 * 🔴 ET UN ÉLÉMENT REFUSÉ NE FAIT PAS TOMBER LE LOT : c'est le contrat du lot depuis toujours (un lot de 500
 * dont la ligne 37 est fausse écrit 499 fiches). Seul un CONTENEUR malformé rend 400.
 */
function trierLeLot(bruts: unknown[]): { valides: Array<{ index: number; contact: ContactV1 }>; refus: ResultatFiche[] } {
  const valides: Array<{ index: number; contact: ContactV1 }> = [];
  const refus: ResultatFiche[] = [];
  bruts.forEach((brut, index) => {
    const r = schemaContactV1.safeParse(brut);
    if (r.success) valides.push({ index, contact: r.data });
    else refus.push({ index, status: 'error', code: 'invalid_body', reason: raisonDeValidation(r.error) });
  });
  return { valides, refus };
}

/**
 * Les routes publiques des FICHES (spec de l'API publique, § 2). L'espace vient à 100 % de `req.auth`, posé
 * par la garde de clé : aucun `:tenantId` dans l'adresse. Toute erreur a la forme `{ error, code }`.
 *
 * ⚠️ `PATCH` compte sous `contacts.upsert` : c'est une écriture d'UNE fiche, du même poids.
 */
export function registerV1Contacts(app: FastifyInstance, deps: V1ContactsRouteDeps, gardes: GardesContactsV1): void {
  const ecrire = { preHandler: gardes.ecrire };
  const lire = { preHandler: gardes.lire };

  app.post('/v1/contacts', ecrire, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    /**
     * ⚠️ LA MÊME VALIDATION QUE LE LOT, ET PAS UNE VARIANTE. Fermer une porte en laissant l'autre ouverte est
     * le motif « une capacité câblée sur un consommateur sur deux », déjà payé plusieurs fois dans ce dépôt.
     */
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
     * ⚠️ LE TRAVAIL EST COMPTÉ SUR CE QUE L'APPELANT DEMANDE, pas sur ce qui survit à la validation. Un lot
     * de 500 lignes dont 400 sont malformées a bel et bien coûté 500 validations : compter 100 laisserait
     * une boucle de corps invalides invisible des compteurs, c'est-à-dire exactement le cas qu'on surveille.
     */
    if (!await compterOuRefuser(deps.usage, req, reply, 'contacts.batch', bruts.length)) return reply;

    const { valides, refus } = trierLeLot(bruts);
    const ecrits = valides.length === 0
      ? []
      : (await deps.ecrireFiches(req.auth.tenantId, valides.map((v) => v.contact)))
        // Le service numérote SA liste : on reporte chaque résultat sur l'index d'origine.
        .map((r) => ({ ...r, index: valides[r.index]?.index ?? r.index }));
    const results = [...refus, ...ecrits].sort((a, b) => a.index - b.index);
    const created = results.filter((r) => r.status === 'created').length;
    const updated = results.filter((r) => r.status === 'updated').length;
    // ⚠️ LES REFUS DE VALIDATION COMPTENT DANS `errors`, comme les refus du service : un seul compteur pour
    // l'intégrateur, qui n'a pas à savoir où le refus a été décidé.
    const errors = results.filter((r) => r.status === 'error').length;
    return reply.code(200).send({ results, created, updated, errors });
  });

  /**
   * 🔴 LE NUMÉRO VOYAGE DANS LE CORPS, JAMAIS DANS L'ADRESSE : `/v1/contacts/+33…` l'inscrirait dans les
   * journaux d'accès du proxy et de Cloudflare.
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
