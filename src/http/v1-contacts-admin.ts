import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import type { AuditSink } from '../audit/journal';
import { journalDeLApi } from '../api/journal-api';
import { refuser } from '../api/erreurs';
import { messageDeForme } from '../api/forme';
import { compterOuRefuser, type ApiUsageGuard } from '../api/usage-guard';
import { USER_FIELD_TYPES } from '../crm/fields';
import { effacerContacts, type DepsEffacement } from '../crm/effacement';
import { creerChamp, type ChampsDep } from './fields';
import { LimiteOffreError, STATUT_REFUS_OFFRE, corpsRefusLimite } from '../offres/refus';
import type { BulkTarget } from '../crm/contact-store.pg';

/**
 * LES CONTACTS COMPLETS PAR L'API (lot 13, domaine 5, livraison A, spec § 7) : les champs personnalisés (lister, créer)
 * et la suppression RGPD d'une fiche. 🔴 Aucune logique ici : la création de champ de l'écran Contenu (`creerChamp`) et
 * l'effacement de la purge du mini-CRM (`effacerContacts` : la limite du jour de l'offre, tout ou rien, puis la purge,
 * puis le retrait chez l'agent de Meta après la réponse).
 *
 * Gardes attendues : `contacts:read` pour la liste des champs (ses clés figurent déjà dans les fiches que ce droit lit),
 * `contacts:admin` (droit NEUF, sans reprise) pour créer un champ et effacer une fiche. L'espace vient de `req.auth`.
 */
export interface V1ContactsAdminRouteDeps extends DepsEffacement {
  usage: ApiUsageGuard;
  /** Le référentiel des champs de l'écran Contenu, le MÊME objet (`src/index.ts`). */
  champs: Pick<ChampsDep, 'list' | 'create'>;
  /** La résolution d'une cible en identifiants DANS l'espace (`PgContactStore.contactIdsForTarget`). */
  contacts: DepsEffacement['contacts'] & { contactIdsForTarget(tenantId: string, target: BulkTarget): Promise<string[]> };
  audit: AuditSink;
}

export interface GardesContactsAdminV1 {
  lire: Guard;
  administrer: Guard;
}

/** Un champ personnalisé, tel que l'API le rend : la clé à utiliser dans `fields` des fiches. */
export interface ChampV1 { key: string; label: string; type: string }

/** Exporté pour la doc : ses exemples passent par la MÊME règle (`tests/api-exemples.test.ts`). */
export const corpsChamp = z.strictObject({
  label: z.string().trim().min(1).max(100),
  type: z.enum(USER_FIELD_TYPES as [string, ...string[]]),
});
const parametresFiche = z.object({ contactId: z.string().uuid() });

export function registerV1ContactsAdmin(app: FastifyInstance, deps: V1ContactsAdminRouteDeps, gardes: GardesContactsAdminV1): void {
  const lire = { preHandler: gardes.lire };
  const administrer = { preHandler: gardes.administrer };
  // Pas `makeJournal` : derrière une clé, l'acteur n'est pas un compte (`src/api/journal-api.ts`).
  const journal = journalDeLApi(deps.audit);

  app.get('/v1/fields', lire, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    if (!await compterOuRefuser(deps.usage, req, reply, 'contacts.read')) return reply;
    const champs = await deps.champs.list(req.auth.tenantId);
    return reply.code(200).send({ data: champs.map((c): ChampV1 => ({ key: c.key, label: c.label, type: c.type })) });
  });

  app.post('/v1/fields', administrer, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    if (!await compterOuRefuser(deps.usage, req, reply, 'contacts.admin')) return reply;
    const lu = corpsChamp.safeParse(req.body);
    if (!lu.success) return refuser(reply, 400, 'invalid_body', messageDeForme(lu.error));
    const r = await creerChamp(deps.champs, req.auth.tenantId, lu.data.label, lu.data.type);
    if (!r.ok) return refuser(reply, r.statut, r.statut === 409 ? 'field_exists' : 'invalid_body', r.erreur);
    return reply.code(201).send({ key: r.champ.key, label: r.champ.label, type: r.champ.type } satisfies ChampV1);
  });

  /**
   * 🔴 Irréversible : la fiche, ses conversations, ses messages et son analyse sont effacés, ce qui porte les compteurs
   * est anonymisé. Une fiche d'un autre espace (ou inconnue) rend 404 SANS consommer la limite du jour.
   */
  app.delete('/v1/contacts/:contactId', administrer, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    if (!await compterOuRefuser(deps.usage, req, reply, 'contacts.admin')) return reply;
    const t = req.auth.tenantId;
    const p = parametresFiche.safeParse(req.params);
    if (!p.success) return refuser(reply, 404, 'unknown_contact', 'fiche inconnue');
    const ids = await deps.contacts.contactIdsForTarget(t, { ids: [p.data.contactId] });
    if (ids.length === 0) return refuser(reply, 404, 'unknown_contact', 'fiche inconnue');
    const e = await effacerContacts(deps, t, ids);
    if (!e.ok) return reply.code(STATUT_REFUS_OFFRE).send(corpsRefusLimite(new LimiteOffreError(t, 'suppressionsJour', e.max)));
    for (const id of ids) await journal(t, req, 'contact.purged', { kind: 'contact', id }, { lot: ids.length, via: 'api' });
    // La réponse part d'abord, le retrait chez Meta ensuite, au mieux (voir `effacerContacts`).
    reply.code(200).send({ deleted: true, conversations: e.bilan.conversations, messages: e.bilan.messages });
    e.retirerChezMeta();
    return reply;
  });
}
