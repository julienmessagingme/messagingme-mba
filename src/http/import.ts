import type { FastifyInstance } from 'fastify';
import { apercuCsvHorsBoucle, parseCsvHorsBoucle } from '../crm/csv';
import { recognizeColumns } from '../crm/recognize';
import { importContacts } from '../crm/import';
import type { ContactStore, ImportDeps } from '../crm/import';
import type { ColumnMapping } from '../crm/types';
import type { ContactRow, ContactFilters, ContactFieldFilter } from '../crm/contact-store.pg';
import { gardeEtendue } from '../auth/middleware';
import type { Guard, PreHandler } from '../auth/middleware';
import { espaceVerifie } from './scope';
import { buildContactFilters, normalizeFieldFilters } from '../crm/contact-filters';
import { makeJournal, type AuditSink } from '../audit/journal';

/** Ce que les routes de liste lisent du dépôt des contacts, en plus de ce que l'import y écrit. */
export interface ContactsListeDep extends ContactStore {
  list(tenantId: string, limit?: number, offset?: number, tag?: string): Promise<ContactRow[]>;
  /** Requête filtrée + paginée (source « Liste de contacts » de campagne). */
  query(tenantId: string, filters: ContactFilters, limit?: number, offset?: number): Promise<ContactRow[]>;
  /** Nombre total correspondant aux filtres (compteur avant de fixer le débit). */
  count(tenantId: string, filters: ContactFilters): Promise<number>;
  /** Ids correspondant aux filtres (résolution serveur de la source de campagne). */
  idsForFilters(tenantId: string, filters: ContactFilters): Promise<string[]>;
}

export interface ImportRouteDeps extends ImportDeps {
  contacts: ContactsListeDep;
  /**
   * Journal d'audit (les fixtures qui ne l'observent pas passent `journalMuet`). Un import fait entrer des personnes
   * par milliers : sans trace, personne ne peut dire d'où vient un contact ni qui l'a chargé.
   */
  audit: AuditSink;
}

/** Parse les critères de « Liste de contacts » depuis les query params (tous optionnels, valeurs = strings).
*  `tags`/`tagsExclude`=CSV, `fields`=JSON `[{key,op,value}]` (défensif : ignoré si illisible). Bornes anti-abus.
*  Seule exception à « ignoré » : un `risque` hors des quatre niveaux est refusé (400, `FiltreContactInvalide`).
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
    joignabilite: q.joignabilite,
    // Une valeur hors des quatre niveaux lève `FiltreContactInvalide` (400), jamais ignorée : cf. `risqueFiltre`.
    risque: q.risque,
    fieldFilters,
  });
}

/** Un des filtres avancés est-il posé ? (sinon on garde le chemin `listContacts` historique, avec `tag`.) */
function hasFilters(f: ContactFilters): boolean {
  // 🔴 Tout nouveau critère entre ici aussi : un critère oublié n'échoue pas, il retombe sur la liste par défaut,
  // donc il s'affiche coché et ne filtre rien.
  return Boolean(f.tags?.length || f.tagsExclude?.length || f.optIn || f.phonePrefix || f.phoneContains || f.nameSearch || f.joignabiliteWhatsApp || f.risque || f.fieldFilters?.length);
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
 * POST /tenants/:tenantId/contacts/import : parse un CSV brut, reconnaît les colonnes (sans mapping fourni),
 * upsert les contacts. Rend un ImportReport.
 */
export function registerImport(app: FastifyInstance, deps: ImportRouteDeps, garde: Guard, limiteCouteuse?: PreHandler): void {
  const opts = { preHandler: garde };
  // Garde des routes coûteuses : la garde habituelle plus le plafond par espace. `gardeEtendue` aplatit la
  // chaîne, parce que `gardeAdmin` est déjà un tableau et qu'un tableau imbriqué ne serait pas exécuté.
  const couteux = gardeEtendue(garde, limiteCouteuse);
  const journal = makeJournal(deps.audit);
  // Le CSV complet transite dans le corps. 8 Mo (environ 150 000 contacts), pas plus : le corps est parsé d'un
  // bloc (l'API ne répond à personne d'autre pendant ce temps), et 8 Mo de CSV pèsent ~150 Mo de tas en objets.
  const optsImportCouteux = { ...couteux, bodyLimit: 8 * 1024 * 1024 };
  // L'aperçu ne reçoit que la tête du fichier (cf. `TETE_APERCU_CARACTERES` côté console) : assez pour les
  // en-têtes et quatre lignes d'exemple. Le plafond reste large devant cette tête sans laisser passer un fichier.
  const optsApercuCouteux = { ...couteux, bodyLimit: 2 * 1024 * 1024 };

  app.get('/tenants/:tenantId/contacts', opts, async (req, reply) => {
    const effectiveTenant = espaceVerifie(req);
    const q = req.query as Record<string, unknown>;
    const limit = typeof q.limit === 'string' ? Number(q.limit) : undefined;
    const offset = typeof q.offset === 'string' ? Number(q.offset) : undefined;
    const filters = parseFilters(q);
    // Filtres avancés posés -> chemin requêtable (query + total pour le compteur). Sinon on garde le
    // chemin historique `listContacts` (avec le paramètre `tag` simple), rétro-compatible.
    if (hasFilters(filters)) {
      const [contacts, total] = await Promise.all([
        deps.contacts.query(effectiveTenant, filters, limit, offset),
        deps.contacts.count(effectiveTenant, filters),
      ]);
      return reply.code(200).send({ contacts, total });
    }
    const tag = typeof q.tag === 'string' && q.tag.trim() !== '' ? q.tag.trim() : undefined;
    const contacts = await deps.contacts.list(effectiveTenant, limit, offset, tag);
    return reply.code(200).send({ contacts });
  });

  // Compteur seul (rapide) : « N contacts correspondent » avant de fixer le débit / lancer.
  app.get('/tenants/:tenantId/contacts/count', opts, async (req, reply) => {
    const effectiveTenant = espaceVerifie(req);
    const total = await deps.contacts.count(effectiveTenant, parseFilters(req.query as Record<string, unknown>));
    return reply.code(200).send({ total });
  });

  // Résolution serveur de la source « Liste de contacts » : les ids correspondant aux filtres. Plus aucun appelant
  // (l'écran envoie l'intention `contactTarget`, résolue en base) ; la route reste, primitive de lecture bornée.
  app.get('/tenants/:tenantId/contacts/ids', opts, async (req, reply) => {
    const effectiveTenant = espaceVerifie(req);
    const ids = await deps.contacts.idsForFilters(effectiveTenant, parseFilters(req.query as Record<string, unknown>));
    return reply.code(200).send({ ids });
  });

  // Aperçu : parse le CSV + propose un mapping (même parseCsv que l'import réel -> en-têtes
  // identiques, pas de désync). Le front affiche l'écran de mapping pré-rempli.
  // ⚠️ L'aperçu ne reçoit que la tête du fichier (`teteCsv`, 512 000 caractères) : l'identité tient tant qu'elle
  // porte les 50 rangées où `separateurCsv` cherche le séparateur (plus de 10 000 caractères par rangée en moyenne,
  // l'aperçu et l'import peuvent lire deux séparateurs).
  app.post('/tenants/:tenantId/contacts/import/preview', optsApercuCouteux, async (req, reply) => {
    const effectiveTenant = espaceVerifie(req);
    const body = (req.body ?? {}) as { csv?: unknown };
    if (typeof body.csv !== 'string' || body.csv.trim() === '') {
      return reply.code(400).send({ error: 'csv requis (texte brut)' });
    }
    const apercu = await apercuCsvHorsBoucle(body.csv);
    if (apercu.headers.length === 0) return reply.code(400).send({ error: 'aucune colonne détectée (1re ligne = en-têtes)' });
    return reply.code(200).send({ ...apercu, mapping: mappingFromHeaders(apercu.headers) });
  });

  app.post('/tenants/:tenantId/contacts/import', optsImportCouteux, async (req, reply) => {
    const effectiveTenant = espaceVerifie(req);
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

    // 🔴 Opt-in par défaut, aligné sur l'écran d'import (case pré-cochée) : un appel qui omet le champ chargerait
    // sinon une liste que le garde-fou de campagne écarte du marketing, sans rien signaler.
    const optIn = body.optIn !== false;

    const parsed = await parseCsvHorsBoucle(body.csv);
    const mapping = body.mapping ?? mappingFromHeaders(parsed.headers);
    // 🔴 La case cochée réabonne aussi qui a dit STOP : c'est le seul import qui le peut, parce que l'opérateur le
    // demande. HubSpot, le webhook entrant et la création à la main gardent le STOP.
    const report = await importContacts(
      { rows: parsed.rows, mapping, tenantId: effectiveTenant, optIn, tags, peutLeverStop: optIn },
      deps,
    );
    // Une ligne par lot, pas par contact : un import de 50 000 lignes noierait l'historique. L'opt-in est consigné
    // parce qu'il autorise les envois marketing derrière : c'est la case que l'opérateur a cochée, et elle engage.
    await journal(effectiveTenant, req, 'contact.imported', { kind: 'contact', id: 'lot' }, {
      created: report.created, updated: report.updated, skipped: report.skipped, optIn, tags: tags.length,
    });
    return reply.code(200).send(report);
  });
}
