import type { FastifyInstance } from 'fastify';
import { parseCsv } from '../crm/csv';
import { recognizeColumns } from '../crm/recognize';
import { importContacts } from '../crm/import';
import type { ImportDeps } from '../crm/import';
import type { ColumnMapping } from '../crm/types';
import type { ContactRow, ContactFilters, ContactFieldFilter } from '../crm/contact-store.pg';
import { forbidNonAdmin, gardeEtendue } from '../auth/middleware';
import type { Guard, PreHandler } from '../auth/middleware';
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
 *  ⚠️ Seule exception à « ignoré » : un `risque` hors des quatre niveaux est REFUSÉ (400, `FiltreContactInvalide`).
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
    // Une valeur hors des quatre niveaux LÈVE `FiltreContactInvalide` (400), jamais ignorée : cf. `risqueFiltre`.
    risque: q.risque,
    fieldFilters,
  });
}

/** Un des filtres avancés est-il posé ? (sinon on garde le chemin `listContacts` historique, avec `tag`.) */
function hasFilters(f: ContactFilters): boolean {
  // 🔴 TOUT NOUVEAU CRITÈRE ENTRE ICI AUSSI. Cette porte décide du chemin requêtable : un critère oublié
  // n'echoue pas, il retombe sur la liste par défaut, donc il s'affiche coché et ne filtre RIEN.
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
 * POST /tenants/:tenantId/contacts/import — importe un CSV brut : parse, reconnaît les
 * colonnes (si pas de mapping fourni), upsert les contacts. Retourne un ImportReport.
 */
export function registerImport(app: FastifyInstance, deps: ImportRouteDeps, garde: Guard, limiteCouteuse?: PreHandler): void {
  const opts = { preHandler: garde };
  // Garde des routes coûteuses : la garde habituelle, PLUS le plafond par espace. `gardeEtendue` aplatit la
  // chaîne, parce que `gardeAdmin` est déjà un tableau et qu'un tableau imbriqué ne serait pas exécuté.
  const couteux = gardeEtendue(garde, limiteCouteuse);
  const journal = makeJournal(deps.audit);
  // Le CSV COMPLET transite dans le corps : le plafond global de 1 Mo tombait vers 14 000 lignes, en anglais
  // et sans dire quoi faire. 8 Mo, soit environ 150 000 contacts, très au-delà de tout import réel. Pas plus,
  // pour deux raisons MESURÉES le 2026-08-31 : le corps est parsé D'UN BLOC (~100 ms pour 5,4 Mo ici, donc
  // quelques centaines de ms sur le VPS) et pendant ce temps l'API ne répond à personne d'autre ; et 8 Mo de
  // CSV pèsent ~150 Mo de tas une fois en objets (le conteneur en occupe 130 au repos, sans plafond mémoire,
  // sur un VPS qui a 17 Go libres : ça passe, mais ce n'est pas une marge à dépenser sans compter).
  const optsImportCouteux = { ...couteux, bodyLimit: 8 * 1024 * 1024 };
  // L'aperçu, lui, ne reçoit plus que la TÊTE du fichier (cf. `TETE_APERCU_CARACTERES` côté console) : il
  // n'en faut pas plus pour les en-têtes et quatre lignes d'exemple. Le plafond reste large devant cette tête
  // (accents = 2 octets, échappement JSON) sans jamais laisser passer un fichier entier.
  const optsApercuCouteux = { ...couteux, bodyLimit: 2 * 1024 * 1024 };

  app.get('/tenants/:tenantId/contacts', opts, async (req, reply) => {
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
  app.get('/tenants/:tenantId/contacts/count', opts, async (req, reply) => {
    const effectiveTenant = scopeTenant(req);
    if (effectiveTenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const total = await deps.countContacts(effectiveTenant, parseFilters(req.query as Record<string, unknown>));
    return reply.code(200).send({ total });
  });

  // Résolution serveur de la source « Liste de contacts » d'une campagne : les ids correspondant aux filtres.
  //
  // ⚠️ PLUS AUCUN APPELANT depuis le 2026-09-01. C'était le seul chemin par lequel jusqu'à 100 000
  // identifiants arrivaient dans le navigateur, pour repartir aussitôt dans le corps de la création de
  // campagne, plafonné à 1 Mo : la création échouait vers 25 000 contacts, avant la limite affichée. L'écran
  // envoie désormais l'INTENTION de sélection (`contactTarget`), résolue en base.
  // La route reste montée parce qu'elle est une primitive de lecture légitime, bornée et testée ; la retirer
  // est une décision à prendre à part, elle est notée dans `todo.md`.
  app.get('/tenants/:tenantId/contacts/ids', opts, async (req, reply) => {
    const effectiveTenant = scopeTenant(req);
    if (effectiveTenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const ids = await deps.contactIdsForFilters(effectiveTenant, parseFilters(req.query as Record<string, unknown>));
    return reply.code(200).send({ ids });
  });

  // Aperçu : parse le CSV + propose un mapping (même parseCsv que l'import réel -> en-têtes
  // identiques, pas de désync). Le front affiche l'écran de mapping pré-rempli.
  app.post('/tenants/:tenantId/contacts/import/preview', optsApercuCouteux, async (req, reply) => {
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

  app.post('/tenants/:tenantId/contacts/import', optsImportCouteux, async (req, reply) => {
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

    // OPT-IN PAR DEFAUT, aligne sur l'ecran d'import (sa case est pre-cochee). Les deux disaient l'inverse :
    // l'ecran envoie toujours le booleen, donc le defaut de la route ne se voyait pas, et un appel qui omet le
    // champ chargeait une liste entiere que le garde-fou de campagne ecarte ensuite du marketing (il exige un
    // opt-in EXPLICITE), sans que rien ne le signale. Decision de Julien, 2026-08-19.
    const optIn = body.optIn !== false;

    const parsed = parseCsv(body.csv);
    const mapping = body.mapping ?? mappingFromHeaders(parsed.headers);
    // 🔴 La case cochée RÉABONNE aussi qui a dit STOP : c'est le seul import qui le peut (décision de Julien du
    // 2026-09-26), parce que c'est l'opérateur qui le demande. HubSpot, le webhook entrant et la création à la
    // main gardent le STOP (`upsertManyByPhone`, `upsertByPhoneReturningId`).
    const report = await importContacts(
      { rows: parsed.rows, mapping, tenantId: effectiveTenant, optIn, tags, peutLeverStop: optIn },
      deps,
    );
    // Une ligne par LOT, pas par contact : un import de 50 000 lignes écrirait autant d'entrées, et noierait
    // l'historique qu'on cherche à rendre lisible. L'opt-in est consigné parce que c'est lui qui autorise les
    // envois marketing derrière : c'est la case que l'opérateur a cochée, et elle engage.
    await journal(effectiveTenant, req, 'contact.imported', { kind: 'contact', id: 'lot' }, {
      created: report.created, updated: report.updated, skipped: report.skipped, optIn, tags: tags.length,
    });
    return reply.code(200).send(report);
  });
}
