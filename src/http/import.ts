import type { FastifyInstance } from 'fastify';
import { parseCsv } from '../crm/csv';
import { recognizeColumns } from '../crm/recognize';
import { importContacts } from '../crm/import';
import type { ImportDeps } from '../crm/import';
import type { ColumnMapping } from '../crm/types';
import type { ContactRow, ContactFilters, ContactFieldFilter } from '../crm/contact-store.pg';
import { forbidNonAdmin } from '../auth/middleware';
import type { Guard } from '../auth/middleware';
import { scopeTenant } from './scope';
import { buildContactFilters, normalizeFieldFilters } from '../crm/contact-filters';
import { makeJournal, type AuditSink } from '../audit/journal';

export interface ImportRouteDeps extends ImportDeps {
  listContacts(tenantId: string, limit?: number, offset?: number, tag?: string): Promise<ContactRow[]>;
  /** Requête filtrée + paginée (source « Liste de contacts » de campagne). */
  queryContacts(tenantId: string, filters: ContactFilters, limit?: number, offset?: number): Promise<ContactRow[]>;
  /** Nombre total correspondant aux filtres (compteur AVANT de fixer le débit). */
  countContacts(tenantId: string, filters: ContactFilters): Promise<number>;
  /** Ids correspondant aux filtres (résolution serveur de la source de campagne). */
  contactIdsForFilters(tenantId: string, filters: ContactFilters): Promise<string[]>;
  /**
   * Journal d'audit. Un import est la principale façon dont des personnes ENTRENT dans la base, souvent par
   * milliers d'un coup : sans trace, personne ne peut dire d'où vient un contact ni qui l'a chargé.
   * Optionnel : absent -> aucune trace (câblages de test).
   */
  audit?: AuditSink;
}

/** Parse les critères de « Liste de contacts » depuis les query params (tous optionnels, valeurs = strings).
 *  `tags`/`tagsExclude`=CSV, `fields`=JSON `[{key,op,value}]` (défensif : ignoré si illisible). Bornes anti-abus.
 *  Exporté pour le test de round-trip anti-drift (filtersToQuery côté web <-> parseFilters ici). */
export function parseFilters(q: Record<string, unknown>): ContactFilters {
  const csv = (v: unknown): string[] =>
    typeof v === 'string' ? v.split(',') : [];
  // Les filtres de champ arrivent ici en JSON dans un query param : illisible -> ignoré (donnée externe).
  let fieldFilters: ContactFieldFilter[] = [];
  if (typeof q.fields === 'string' && q.fields.trim() !== '') {
    try {
      const parsed = JSON.parse(q.fields) as unknown;
      if (Array.isArray(parsed)) fieldFilters = normalizeFieldFilters(parsed);
    } catch { /* filtre de champ illisible -> ignoré (donnée externe) */ }
  }
  return buildContactFilters({
    tags: csv(q.tags),
    tagMode: q.tagMode,
    tagsExclude: csv(q.tagsExclude),
    optIn: q.optIn,
    phonePrefix: q.phonePrefix,
    phoneContains: q.phoneContains,
    nameSearch: q.nameSearch,
    fieldFilters,
  });
}

/** Un des filtres avancés est-il posé ? (sinon on garde le chemin `listContacts` historique, avec `tag`.) */
function hasFilters(f: ContactFilters): boolean {
  return Boolean(f.tags?.length || f.tagsExclude?.length || f.optIn || f.phonePrefix || f.phoneContains || f.nameSearch || f.fieldFilters?.length);
}

/** Construit un mapping par défaut depuis la reconnaissance de colonnes. */
export function mappingFromHeaders(headers: string[]): ColumnMapping {
  const columns: ColumnMapping['columns'] = {};
  for (const s of recognizeColumns(headers)) {
    columns[s.header] =
      s.target === 'custom' ? { target: 'custom', key: s.suggestedKey } : { target: s.target };
  }
  return { columns };
}

/**
 * POST /tenants/:tenantId/contacts/import — importe un CSV brut : parse, reconnaît les
 * colonnes (si pas de mapping fourni), upsert les contacts. Retourne un ImportReport.
 */
export function registerImport(app: FastifyInstance, deps: ImportRouteDeps, requireAuth?: Guard): void {
  const guard = requireAuth ? { preHandler: requireAuth } : {};
  const journal = makeJournal(deps.audit);

  app.get('/tenants/:tenantId/contacts', guard, async (req, reply) => {
    const effectiveTenant = scopeTenant(req);
    if (effectiveTenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const q = req.query as Record<string, unknown>;
    const limit = typeof q.limit === 'string' ? Number(q.limit) : undefined;
    const offset = typeof q.offset === 'string' ? Number(q.offset) : undefined;
    const filters = parseFilters(q);
    // Filtres avancés posés -> chemin requêtable (query + total pour le compteur). Sinon on garde le
    // chemin historique `listContacts` (avec le paramètre `tag` simple), rétro-compatible.
    if (hasFilters(filters)) {
      const [contacts, total] = await Promise.all([
        deps.queryContacts(effectiveTenant, filters, limit, offset),
        deps.countContacts(effectiveTenant, filters),
      ]);
      return reply.code(200).send({ contacts, total });
    }
    const tag = typeof q.tag === 'string' && q.tag.trim() !== '' ? q.tag.trim() : undefined;
    const contacts = await deps.listContacts(effectiveTenant, limit, offset, tag);
    return reply.code(200).send({ contacts });
  });

  // Compteur seul (rapide) : « N contacts correspondent » avant de fixer le débit / lancer.
  app.get('/tenants/:tenantId/contacts/count', guard, async (req, reply) => {
    const effectiveTenant = scopeTenant(req);
    if (effectiveTenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const total = await deps.countContacts(effectiveTenant, parseFilters(req.query as Record<string, unknown>));
    return reply.code(200).send({ total });
  });

  // Résolution serveur de la source « Liste de contacts » d'une campagne : les ids correspondant aux filtres
  // (sans charger tout le CRM côté front). L'opt-in marketing reste appliqué au build de la campagne.
  app.get('/tenants/:tenantId/contacts/ids', guard, async (req, reply) => {
    const effectiveTenant = scopeTenant(req);
    if (effectiveTenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const ids = await deps.contactIdsForFilters(effectiveTenant, parseFilters(req.query as Record<string, unknown>));
    return reply.code(200).send({ ids });
  });

  // Aperçu : parse le CSV + propose un mapping (même parseCsv que l'import réel -> en-têtes
  // identiques, pas de désync). Le front affiche l'écran de mapping pré-rempli.
  app.post('/tenants/:tenantId/contacts/import/preview', guard, async (req, reply) => {
    const effectiveTenant = scopeTenant(req);
    if (effectiveTenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const body = (req.body ?? {}) as { csv?: unknown };
    if (typeof body.csv !== 'string' || body.csv.trim() === '') {
      return reply.code(400).send({ error: 'csv requis (texte brut)' });
    }
    const parsed = parseCsv(body.csv);
    if (parsed.headers.length === 0) return reply.code(400).send({ error: 'aucune colonne détectée (1re ligne = en-têtes)' });
    return reply.code(200).send({
      headers: parsed.headers,
      sampleRows: parsed.rows.slice(0, 4),
      rowCount: parsed.rows.length,
      mapping: mappingFromHeaders(parsed.headers),
    });
  });

  app.post('/tenants/:tenantId/contacts/import', guard, async (req, reply) => {
    const effectiveTenant = scopeTenant(req);
    if (effectiveTenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const body = (req.body ?? {}) as { csv?: unknown; optIn?: unknown; mapping?: ColumnMapping; tags?: unknown };

    if (typeof body.csv !== 'string' || body.csv.trim() === '') {
      return reply.code(400).send({ error: 'csv requis (texte brut)' });
    }

    // Tags : accepte une chaîne "a, b, c" ou un tableau ; normalisés (trim, non vides, dédup).
    const rawTags = Array.isArray(body.tags)
      ? (body.tags as unknown[]).map(String)
      : typeof body.tags === 'string'
        ? body.tags.split(',')
        : [];
    // Normalise + borne : 64 car. max par tag, 50 tags max (évite un stockage aberrant).
    const tags = [...new Set(rawTags.map((t) => t.trim().slice(0, 64)).filter((t) => t !== ''))].slice(0, 50);
    // mapping fourni mais malformé (sans `columns` objet) -> 400, sinon Object.entries throw en 500.
    if (body.mapping !== undefined) {
      const cols = (body.mapping as { columns?: unknown }).columns;
      if (typeof cols !== 'object' || cols === null || Array.isArray(cols)) {
        return reply.code(400).send({ error: 'mapping invalide (columns requis)' });
      }
    }

    const parsed = parseCsv(body.csv);
    const mapping = body.mapping ?? mappingFromHeaders(parsed.headers);
    const report = await importContacts(
      { rows: parsed.rows, mapping, tenantId: effectiveTenant, optIn: body.optIn === true, tags },
      deps,
    );
    // Une ligne par LOT, pas par contact : un import de 50 000 lignes écrirait autant d'entrées, et noierait
    // l'historique qu'on cherche à rendre lisible. L'opt-in est consigné parce que c'est lui qui autorise les
    // envois marketing derrière : c'est la case que l'opérateur a cochée, et elle engage.
    await journal(effectiveTenant, req, 'contact.imported', { kind: 'contact', id: 'lot' }, {
      created: report.created, updated: report.updated, skipped: report.skipped, optIn: body.optIn === true, tags: tags.length,
    });
    return reply.code(200).send(report);
  });
}
