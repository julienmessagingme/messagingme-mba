import type { FastifyInstance } from 'fastify';
import { forbidNonAdmin, gardeEtendue } from '../auth/middleware';
import type { Guard, PreHandler } from '../auth/middleware';
import type { ContactRow, ContactFilters, BulkTarget, BulkEdits, IssueActionEnMasse } from '../crm/contact-store.pg';
import type { UserFieldDef } from '../crm/types';
import type { ContactHistory, ContactSend, ResumeContact } from '../crm/contact-history.pg';
import type { CoutContact, NiveauEngagement } from '../stats/cost';
import { validateFieldValue, canonicalizeFieldValue, socleField } from '../crm/fields';
import { classerDemandeArret } from '../crm/consentement';
import { espaceVerifie } from './scope';
import { buildContactFilters, normalizeFieldFilters } from '../crm/contact-filters';
import { makeJournal, type AuditSink } from '../audit/journal';
import type { AuditEntry } from '../audit/store.pg';
import { messageDe } from '../lib/erreur';
import type { ListeDeLAgent, LigneDeLaListe } from '../mba/liste';
import type { TravauxEnVol } from '../lib/en-vol';

/** Ce que les routes lisent et écrivent des fiches de contact. */
export interface ContactsDep {
  /** Applique fields (MERGE) + suppression de fields + Nom + addTags/removeTags en une transaction. null si le
   *  contact n'existe pas dans le tenant, ou s'il est supprimé. `consentementChange` : le statut demandé a été écrit
   *  (faux s'il était déjà en place). */
  applyEdits(
    tenantId: string,
    contactId: string,
    edits: {
      fields: Record<string, string>; removeFields?: string[]; addTags: string[]; removeTags: string[];
      profileName?: string | null; optInStatus?: 'opted_in' | 'opted_out';
    },
  ): Promise<{ contact: ContactRow; addedTags: string[]; consentementChange: boolean } | null>;
  /**
   * Modération : bloque ou débloque un contact. Bloqué = plus aucun envoi, et sa conversation disparaît de
   * l'Inbox.
   */
  setBlocked(tenantId: string, contactId: string, bloque: boolean, parUserId: string | null): Promise<boolean>;
  listBlocked(tenantId: string): Promise<Array<{ id: string; profileName: string | null; phoneE164: string | null; blockedAt: string }>>;
  /**
   * Les contacts qui ont demandé à ne plus être contactés. Requise : « aucun désabonné » et « la liste n'est pas
   * branchée » sont deux situations opposées, et le compilateur interdit la seconde.
   */
  listeDesabonnes(tenantId: string): Promise<Array<{
    id: string; profileName: string | null; phoneE164: string | null; desabonneLe: string | null; source: string | null;
  }>>;
  /** Les messages entrants récents à relire avec la règle élargie. Cf. `PgContactStore.messagesARelire`. */
  messagesARelire(tenantId: string): Promise<{
    scannes: number;
    messages: Array<{ messageId: string; conversationId: string; contactId: string | null; waId: string; profileName: string | null; body: string; recuLe: string }>;
  }>;
  /**
   * Action en masse (tags +/-, poser un champ, consentement) sur une cible (ids ou filtres). Rend le nombre de fiches
   * écrites, et celui des fiches dont le STOP a été gardé : l'action en masse ne lève pas un STOP.
   */
  applyEditsMany(tenantId: string, target: BulkTarget, edits: BulkEdits): Promise<IssueActionEnMasse>;
  /**
   * 🔴 Suppression : efface le contenu (fil, messages, analyse qualitative) et anonymise ce qui porte les
   * compteurs. Irréversible. `listeAgent` : les entrées de la liste de l'agent de Meta dont la ligne vient de
   * partir, à retirer chez Meta après la transaction. Jamais renvoyé au navigateur.
   */
  purgeMany(tenantId: string, ids: readonly string[]): Promise<{
    purges: number; conversations: number; messages: number; analyses: number; listeAgent: LigneDeLaListe[];
  }>;
  /** Résout une cible (ids ou filtres) en identifiants. Nécessaire à la purge, qui travaille par identifiants. */
  contactIdsForTarget(tenantId: string, target: BulkTarget): Promise<string[]>;
}

export interface ContactsRouteDeps {
  contacts: ContactsDep;
  /**
   * Journal d'audit (les fixtures qui ne l'observent pas passent `journalMuet`). Au mieux à l'appel : un journal
   * en échec ne fait jamais échouer l'action métier qu'il observe.
   */
  audit: AuditSink;
  journal: {
    /**
     * Lecture du journal. Séparée de l'écriture : le store est en ajout seul, et rien ici ne doit laisser croire
     * qu'une entrée se modifie.
     */
    list(tenantId: string, opts: { limit?: number; targetId?: string; q?: string; acteur?: string; telephone?: string }): Promise<AuditEntry[]>;
  };
  /**
   * 🔴 Le journal des erreurs de livraison, séparé du journal d'actions : celui-ci porte les numéros (sans eux il
   * ne répond à rien), celui-là n'en porte jamais (y écrire un numéro annulerait une purge).
   */
  erreurs: {
    lister(tenantId: string, filtre: { limit?: number; q?: string; telephone?: string; code?: number }): Promise<unknown[]>;
    /** La moitié système : les appels vers les systèmes du client qui n'ont pas abouti. */
    listerEchecsSysteme(tenantId: string, limit?: number): Promise<unknown[]>;
  };
  champs: {
    /** Définitions des user fields du tenant (pour valider clé + type d'une valeur saisie). */
    list(tenantId: string): Promise<UserFieldDef[]>;
  };
  /**
   * Matérialise un champ socle (`prenom`/`email`) absent de la base. Idempotent. Les fixtures qui ne la
   * regardent pas passent `socleJamaisCree`, qui garde le refus « champ inconnu ».
   */
  ensureSocleField(tenantId: string, key: string, label: string, type: UserFieldDef['type']): Promise<void>;
  /**
   * Crée (ou met à jour) un contact saisi à la main. Délègue au même upsert que le webhook entrant, dont la
   * préparation des champs est aussi celle de l'API publique : un second chemin divergerait sur la
   * normalisation du numéro, l'opt-in ou les champs.
   */
  createOneContact(
    tenantId: string,
    input: { phone: string; name?: string; fields?: Record<string, string>; tags?: string[]; optIn?: boolean; bsuid?: string },
  ): Promise<{ status: 'created' | 'updated' | 'error'; contactId?: string; reason?: string }>;
  contactHistory: {
    /** Envois reçus + conversations tenues par ce contact. null si le contact n'est pas dans le tenant. */
    getContactHistory(tenantId: string, contactId: string): Promise<ContactHistory | null>;
    /**
     * Le résumé de la dernière conversation analysée : la ligne « champ de base » de la fiche. Rien n'est
     * recopié dans la fiche, donc rien ne survit à la purge des conversations. null si le contact n'est pas
     * dans l'espace.
     */
    resumeContact(tenantId: string, contactId: string): Promise<ResumeContact | null>;
    /** Envois du contact pour l'export CSV (non capé). null si le contact n'est pas dans le tenant. */
    listSendsForExport(tenantId: string, contactId: string): Promise<ContactSend[] | null>;
  };
  /**
   * Ce qu'un contact a coûté, et jusqu'où il est allé. Elle appelle Meta pour les tarifs : son échec ne doit pas
   * empêcher la fiche contact de s'ouvrir, qui appelle cette route à part.
   */
  getBilanContact(tenantId: string, contactId: string): Promise<{ cout: CoutContact; entonnoir: NiveauEngagement[] } | null>;
  /**
   * Signale qu'un tag vient d'être posé sur un contact, pour les automations « tag ajouté ». Au mieux : l'édition
   * a déjà réussi. 🔴 Absent de l'action en masse et de l'import : un tag posé sur des milliers de contacts
   * déclencherait autant de scénarios, donc autant de messages facturés.
   */
  emitTagAdded(tenantId: string, contactId: string, tags: string[]): Promise<void>;
  /**
   * 🔴 Retire chez Meta les contacts purgés qui étaient sur la liste de l'agent (`ListeDeLAgent.oublierChezMeta`) :
   * le numéro d'un contact effacé n'a rien à faire chez Meta. Requise : optionnelle, un câblage qui l'oublierait
   * laisserait ces numéros chez Meta sans rien dire. Au mieux, après la purge : ne lève jamais.
   */
  listeDeLAgent: Pick<ListeDeLAgent, 'oublierChezMeta'>;
  /**
   * Les travaux que la réponse laisse derrière elle (`src/lib/en-vol.ts`) : le retrait chez Meta des contacts purgés
   * part APRÈS la réponse, et l'arrêt de la copie doit l'attendre. Requis : oublié, un arrêt laisserait chez Meta
   * des numéros dont notre table a déjà perdu la trace, donc plus jamais retirés.
   */
  enVol: Pick<TravauxEnVol, 'suivre'>;
}

/** Borne les listes d'ids d'une action en masse (dédup, non vides). Au-delà du plafond, on tronque
 *  (le front vise plutôt `{filters, excludeIds}` que d'envoyer 100k ids). */
const asIdArray = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.map(String).map((s) => s.trim()).filter((s) => s !== ''))].slice(0, 100_000) : [];

/** Normalise un ContactFilters depuis un corps JSON (donnée cliente). Le corps porte des tableaux là où les
*  query params portent des chaînes CSV : seul ce décodage est local, les règles viennent de crm/contact-filters. */
function normalizeContactFilters(raw: unknown): ContactFilters {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const liste = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  return buildContactFilters({
    tags: liste(r.tags),
    tagMode: r.tagMode,
    tagsExclude: liste(r.tagsExclude),
    optIn: r.optIn,
    phonePrefix: r.phonePrefix,
    phoneContains: r.phoneContains,
    nameSearch: r.nameSearch,
    joignabilite: r.joignabiliteWhatsApp,
    // Hors des quatre niveaux : 400 (`FiltreContactInvalide`), y compris pour la cible d'une campagne.
    risque: r.risque,
    fieldFilters: Array.isArray(r.fieldFilters) ? normalizeFieldFilters(r.fieldFilters) : [],
  });
}

/**
 * Cible d'une action en masse depuis le corps : `ids` non vides -> par ids ; sinon `filters` (+ `excludeIds`).
 * null si aucune cible exploitable (-> 400, jamais un UPDATE global par erreur). Exportée : la création de
 * campagne désigne ses destinataires de la même façon, et un second analyseur ferait viser à une campagne autre
 * chose que ce que montrait le mini-CRM.
 */
export function parseBulkTarget(raw: unknown): BulkTarget | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const t = raw as { ids?: unknown; filters?: unknown; excludeIds?: unknown };
  if (Array.isArray(t.ids) && t.ids.length > 0) {
    const ids = asIdArray(t.ids);
    return ids.length > 0 ? { ids } : null;
  }
  if (t.filters !== undefined) {
    return { filters: normalizeContactFilters(t.filters), excludeIds: asIdArray(t.excludeIds) };
  }
  return null;
}

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.map(String).map((t) => t.trim().slice(0, 64)).filter((t) => t !== ''))].slice(0, 50) : [];

/**
 * Définition d'un champ pour valider une valeur saisie. Un champ socle (`prenom`/`email`) absent est matérialisé
 * à la volée (l'écran le propose dès l'ouverture d'un espace) ; tout autre champ inconnu reste refusé, pour
 * qu'une faute de frappe ne crée pas un champ fantôme.
 */
async function defPourEcriture(deps: ContactsRouteDeps, tenantId: string, key: string): Promise<UserFieldDef | undefined> {
  const lu = async (): Promise<UserFieldDef | undefined> => (await deps.champs.list(tenantId)).find((d) => d.key === key);
  const def = await lu();
  if (def) return def;
  const socle = socleField(key);
  if (!socle) return undefined;
  await deps.ensureSocleField(tenantId, socle.key, socle.label, socle.type);
  return lu();
}

export function registerContacts(app: FastifyInstance, deps: ContactsRouteDeps, garde: Guard, gardeEncadrement: Guard, limiteCouteuse?: PreHandler): void {
  const opts = { preHandler: garde };
  /**
   * L'encadrement (`admin` et `manager`), pour les lectures de conformité seulement : désabonnés, refus possibles,
   * journal des actions et les deux moitiés du journal des erreurs. Consulter n'est pas décider : brancher un
   * connecteur sur le consentement, purger ou bloquer restent `forbidNonAdmin`. `web/lib/nav.ts` porte la liste
   * des écrans ouverts.
   */
  // La garde d'encadrement seule, pas empilée sur `garde` : `garde` est `g.admin`, dont le contrôle de rôle
  // refuserait le manager avant que l'encadrement soit lu.
  const optsEncadrement = { preHandler: gardeEncadrement };
  // Garde des routes coûteuses : la garde habituelle plus le plafond par espace (chaîne aplatie).
  const couteux = gardeEtendue(garde, limiteCouteuse);
  const journal = makeJournal(deps.audit);

  /**
   * Les contacts désabonnés : la liste du centre de Sécurité & compliance, réservée à l'encadrement (elle nomme
   * des personnes avec leur numéro). 🔴 `tenant_id = $1` dans la requête en plus de `scopeTenant` : le pooler est
   * superuser, la RLS est contournée, le filtrage en code est le seul contrôle.
   */
  app.get('/tenants/:tenantId/contacts/desabonnes', optsEncadrement, async (req, reply) => {
    const tenant = espaceVerifie(req);
    return reply.code(200).send({ contacts: await deps.contacts.listeDesabonnes(tenant) });
  });

  /**
   * Les refus possibles à confirmer : ce que la règle élargie aurait attrapé, sans l'appliquer. Cette route
   * n'écrit rien et n'a désabonné personne : c'est l'instrument avant de décider. Le nombre de messages scannés
   * remonte (`scannes`) : une liste vide après n'avoir rien lu ne dit pas la même chose qu'après avoir tout lu.
   */
  app.get('/tenants/:tenantId/contacts/refus-possibles', optsEncadrement, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { scannes, messages } = await deps.contacts.messagesARelire(tenant);
    // La règle vit dans `src/crm/consentement.ts`, avec ses tests. Elle n'est pas recopiée ici.
    const refus = messages.filter((m) => classerDemandeArret(m.body) === 'peut_etre');
    return reply.code(200).send({ scannes, refus });
  });

  app.get('/tenants/:tenantId/contacts/blocked', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    return reply.code(200).send({ contacts: await deps.contacts.listBlocked(tenant) });
  });

  /**
   * Bloque ou débloque un contact. Admin seulement : c'est une décision qui coupe la relation avec un client,
   * et qui doit rester traçable à une personne.
   */
  app.patch('/tenants/:tenantId/contacts/:contactId/blocked', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const bloque = (req.body as { blocked?: unknown } | null)?.blocked;
    if (typeof bloque !== 'boolean') return reply.code(400).send({ error: 'blocked (booléen) requis' });
    const { contactId } = req.params as { contactId: string };
    const ok = await deps.contacts.setBlocked(tenant, contactId, bloque, req.auth?.userId ?? null);
    if (!ok) return reply.code(404).send({ error: 'contact inconnu' });
    return reply.code(200).send({ contactId, blocked: bloque });
  });

  app.patch('/tenants/:tenantId/contacts/:contactId', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const { contactId } = req.params as { contactId: string };

    const b = (req.body ?? {}) as { fields?: unknown; removeFields?: unknown; addTags?: unknown; removeTags?: unknown; profileName?: unknown; optInStatus?: unknown };
    const rawFields = b.fields && typeof b.fields === 'object' && !Array.isArray(b.fields) ? (b.fields as Record<string, unknown>) : {};
    const addTags = asStringArray(b.addTags);
    const removeTags = asStringArray(b.removeTags);

    // Valide les champs contre les définitions user_fields du tenant.
    const values: Record<string, string> = {};
    for (const [key, raw] of Object.entries(rawFields)) {
      const def = await defPourEcriture(deps, tenant, key);
      if (!def) return reply.code(400).send({ error: `champ inconnu : ${key}` });
      const val = String(raw);
      if (!validateFieldValue(def.type, val)) return reply.code(400).send({ error: `valeur invalide pour « ${def.label} » (${def.type})` });
      values[key] = canonicalizeFieldValue(def.type, val);
    }

    // Suppression de valeurs de champs : n'importe quelle clé présente sur le contact (l'opérateur jsonb `- text[]`
    // est inoffensif et scopé). On accepte donc les clés sans définition (champ « orphelin » dont le def a été
    // supprimé mais dont la valeur traîne encore sur le contact) : sinon elles seraient impossibles à retirer.
    const removeFields = Array.isArray(b.removeFields)
      ? [...new Set(b.removeFields.map(String).map((k) => k.trim()).filter((k) => k !== ''))].slice(0, 50)
      : [];

    // Nom (profile_name) éditable : chaîne bornée ; vide -> null (on vide). undefined -> on ne touche pas.
    let profileName: string | null | undefined;
    if (b.profileName !== undefined) {
      if (b.profileName !== null && typeof b.profileName !== 'string') return reply.code(400).send({ error: 'profileName invalide' });
      const trimmed = typeof b.profileName === 'string' ? b.profileName.trim().slice(0, 200) : '';
      profileName = trimmed === '' ? null : trimmed;
    }

    // 🔴 Consentement posé à la main depuis la fiche, deux valeurs seulement : « inconnu » veut dire « rien n'a
    // jamais été enregistré », et le réécrire après coup falsifierait le registre au lieu de le corriger.
    let optInStatus: 'opted_in' | 'opted_out' | undefined;
    if (b.optInStatus !== undefined) {
      if (b.optInStatus !== 'opted_in' && b.optInStatus !== 'opted_out') {
        return reply.code(400).send({ error: 'consentement invalide (opted_in | opted_out)' });
      }
      optInStatus = b.optInStatus;
    }

    if (Object.keys(values).length === 0 && removeFields.length === 0 && addTags.length === 0 && removeTags.length === 0 && profileName === undefined && optInStatus === undefined) {
      return reply.code(400).send({ error: 'rien à modifier (fields / removeFields / addTags / removeTags / profileName / optInStatus)' });
    }

    // Une transaction : MERGE/suppression fields + Nom + tags, ou 404 si le contact n'est pas dans le tenant ou s'il
    // est supprimé (purgé).
    const updated = await deps.contacts.applyEdits(tenant, contactId, {
      fields: values, removeFields, addTags, removeTags,
      ...(profileName !== undefined ? { profileName } : {}),
      ...(optInStatus !== undefined ? { optInStatus } : {}),
    });
    if (!updated) return reply.code(404).send({ error: 'contact inconnu' });
    // Journalisé comme la bascule en masse : c'est la même décision, prise sur une fiche au lieu d'une liste.
    // Après l'écriture réussie, sinon on consignerait un consentement qu'on n'a pas posé. Et seulement s'il a changé :
    // enregistrer une fiche dont le statut est déjà en place n'écrit rien, une trace dirait le contraire.
    if (optInStatus !== undefined && updated.consentementChange) {
      await journal(tenant, req, optInStatus === 'opted_in' ? 'contact.optin' : 'contact.optout', { kind: 'contact', id: contactId }, { source: 'fiche' });
    }
    // Automations « tag ajouté », sur les tags réellement nouveaux (reposer un tag présent ne change rien). Après
    // l'écriture réussie et au mieux (un incident de file ne transforme pas l'édition en erreur), mais l'échec est
    // journalisé : sans trace, une automation muette serait indébogable.
    if (updated.addedTags.length > 0) {
      await deps.emitTagAdded(tenant, contactId, updated.addedTags).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error('emitTagAdded ignoré (best-effort):', messageDe(err));
      });
    }
    return reply.code(200).send({ contact: updated.contact });
  });

  /**
   * Historique d'un contact : campagnes reçues et conversations tenues. Lecture seule, admin. Le segment
   * `/history` évite une ambiguïté de routage avec `/contacts/count` et `/contacts/ids` (`src/http/import.ts`).
   */
  app.get('/tenants/:tenantId/contacts/:contactId/history', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { contactId } = req.params as { contactId: string };
    const history = await deps.contactHistory.getContactHistory(tenant, contactId);
    if (!history) return reply.code(404).send({ error: 'contact inconnu' });
    return reply.code(200).send(history);
  });

  /**
   * Le résumé de la dernière conversation analysée, ligne « champ de base » de la fiche. Route à part de
   * `/history` pour être rapide : elle part à l'ouverture de la fiche, l'historique seulement au clic. Admin : ce
   * texte a la substance du fil lui-même.
   */
  app.get('/tenants/:tenantId/contacts/:contactId/resume', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { contactId } = req.params as { contactId: string };
    const resume = await deps.contactHistory.resumeContact(tenant, contactId);
    if (!resume) return reply.code(404).send({ error: 'contact inconnu' });
    return reply.code(200).send(resume);
  });

  /**
   * Le bilan d'un contact : ce qu'il a coûté, et son entonnoir d'engagement. Route à part de `/history` parce
   * qu'elle appelle Meta pour les tarifs : l'historique reste une lecture locale, les deux partent en parallèle.
   */
  app.get('/tenants/:tenantId/contacts/:contactId/bilan', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { contactId } = req.params as { contactId: string };
    const bilan = await deps.getBilanContact(tenant, contactId);
    if (!bilan) return reply.code(404).send({ error: 'contact inconnu' });
    return reply.code(200).send(bilan);
  });

  /**
   * Envois du contact pour l'export CSV, non capé. Renvoie du JSON `{ sends: [...] }` (le front construit et
   * télécharge le CSV : le wrapper `request()` fait toujours res.json(), donc pas de CSV brut côté serveur). Admin-only.
   */
  app.get('/tenants/:tenantId/contacts/:contactId/history/export', couteux, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { contactId } = req.params as { contactId: string };
    const sends = await deps.contactHistory.listSendsForExport(tenant, contactId);
    if (!sends) return reply.code(404).send({ error: 'contact inconnu' });
    /**
     * 🔴 Une extraction de données personnelles laisse une trace : c'est le geste qu'un DPO veut retracer. Le
     * nombre, pas le contenu : écrire les lignes recopierait dans une table jamais purgée ce que l'export montre.
     */
    await journal(tenant, req, 'contact.exporte', { kind: 'contact', id: contactId }, { envois: sends.length });
    return reply.code(200).send({ sends });
  });

  /**
   * Crée un contact à la main (admin, espace du JWT). Délègue à l'upsert partagé : le numéro est normalisé comme
   * ailleurs, et un numéro déjà connu met le contact à jour ; la réponse dit lequel des deux (`status`).
   */
  app.post('/tenants/:tenantId/contacts', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const b = (req.body ?? {}) as { phone?: unknown; name?: unknown; fields?: unknown; tags?: unknown; optIn?: unknown; bsuid?: unknown };
    const phone = typeof b.phone === 'string' ? b.phone.trim() : '';
    if (phone === '') return reply.code(400).send({ error: 'téléphone requis' });
    const rawFields = b.fields && typeof b.fields === 'object' && !Array.isArray(b.fields) ? (b.fields as Record<string, unknown>) : {};

    // Les champs sont validés ici contre les définitions de l'espace, alors que l'upsert partagé auto-créerait
    // toute clé inconnue : une saisie à la main ne doit pas inventer un champ. Un champ socle absent est matérialisé.
    const fields: Record<string, string> = {};
    for (const [key, raw] of Object.entries(rawFields)) {
      const val = String(raw ?? '').trim();
      if (val === '') continue;
      const def = await defPourEcriture(deps, tenant, key);
      if (!def) return reply.code(400).send({ error: `champ inconnu : ${key}` });
      if (!validateFieldValue(def.type, val)) return reply.code(400).send({ error: `valeur invalide pour « ${def.label} » (${def.type})` });
      fields[key] = canonicalizeFieldValue(def.type, val);
    }

    // 🔴 Opt-in par défaut : saisir un numéro à la main suppose qu'on l'a obtenu de la personne ; muet, le contact
    // serait écarté du marketing sans que l'écran le dise. Calculé une fois : la valeur sert à créer et à journaliser.
    const optIn = b.optIn !== false;

    const name = typeof b.name === 'string' && b.name.trim() !== '' ? b.name.trim().slice(0, 120) : undefined;
    const res = await deps.createOneContact(tenant, {
      phone,
      ...(name ? { name } : {}),
      ...(Object.keys(fields).length > 0 ? { fields } : {}),
      tags: asStringArray(b.tags),
      optIn,
      // Facultatif, et surtout pas une seconde identité obligatoire : le numéro reste la clé de ce chemin.
      ...(typeof b.bsuid === 'string' && b.bsuid.trim() !== '' ? { bsuid: b.bsuid.trim().slice(0, 200) } : {}),
    });
    if (res.status === 'error') return reply.code(400).send({ error: res.reason ?? 'contact invalide' });
    // Le détail dit `updated` quand le numéro était déjà connu : sans ça, l'historique laisserait croire à une
    // création alors que la fiche existait. L'opt-in figure ici plutôt que sur une ligne `contact.optin` à part,
    // parce qu'il n'y a eu qu'une action de l'opérateur.
    await journal(tenant, req, 'contact.created', { kind: 'contact', id: res.contactId ?? 'inconnu' }, { status: res.status, optIn });
    return reply.code(res.status === 'created' ? 201 : 200).send({ status: res.status, contactId: res.contactId });
  });

  app.post('/tenants/:tenantId/contacts/bulk', couteux, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;

    const b = (req.body ?? {}) as { target?: unknown; action?: unknown };
    const target = parseBulkTarget(b.target);
    if (target === null) return reply.code(400).send({ error: 'cible invalide (target: { ids } ou { filters, excludeIds })' });
    const action = (b.action ?? {}) as { type?: unknown; tags?: unknown; key?: unknown; value?: unknown };

    if (action.type === 'add_tag' || action.type === 'remove_tag') {
      const tags = asStringArray(action.tags);
      if (tags.length === 0) return reply.code(400).send({ error: 'tag(s) requis' });
      const edits: BulkEdits = action.type === 'add_tag' ? { addTags: tags } : { removeTags: tags };
      const { affected } = await deps.contacts.applyEditsMany(tenant, target, edits);
      return reply.code(200).send({ affected });
    }

    if (action.type === 'set_field') {
      const key = typeof action.key === 'string' ? action.key.trim() : '';
      if (key === '') return reply.code(400).send({ error: 'champ requis (key)' });
      const def = await defPourEcriture(deps, tenant, key);
      if (!def) return reply.code(400).send({ error: `champ inconnu : ${key}` });
      const val = String(action.value ?? '');
      if (!validateFieldValue(def.type, val)) return reply.code(400).send({ error: `valeur invalide pour « ${def.label} » (${def.type})` });
      const { affected } = await deps.contacts.applyEditsMany(tenant, target, { setField: { key, value: canonicalizeFieldValue(def.type, val) } });
      return reply.code(200).send({ affected });
    }

    if (action.type === 'set_optin') {
      // L'import ne fait jamais régresser un statut. `opted_out` se pose ici (action en masse), sur la fiche,
      // par le mot-clé entrant ou par l'API publique (`consent`) : la liste qui fait foi est dérivée par
      // `tests/optout-poussee.test.ts`. 🔴 L'action en masse ne lève pas un STOP : `stopsGardes` dit combien de
      // fiches l'ont gardé, et l'écran le montre (il tolère une réponse sans ce nombre, celle d'une API plus ancienne).
      const value = action.value === 'opted_in' || action.value === 'opted_out' ? action.value : null;
      if (value === null) return reply.code(400).send({ error: 'valeur requise (opted_in | opted_out)' });
      const { affected, stopsGardes } = await deps.contacts.applyEditsMany(tenant, target, { setOptIn: value });
      await journal(tenant, req, value === 'opted_in' ? 'contact.optin' : 'contact.optout', { kind: 'contact', id: 'lot' }, { affected, stopsGardes });
      return reply.code(200).send({ affected, stopsGardes });
    }

    return reply.code(400).send({ error: 'action inconnue (add_tag | remove_tag | set_field | set_optin)' });
  });

  /**
   * Historique d'audit de l'espace, du plus récent au plus ancien. Lecture seule, encadrement. `targetId` filtre
   * sur un contact précis (fiche).
   */
  app.get('/tenants/:tenantId/audit', optsEncadrement, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const q = (req.query ?? {}) as { limit?: unknown; targetId?: unknown; q?: unknown; acteur?: unknown; telephone?: unknown };
    const limit = Number.isFinite(Number(q.limit)) ? Number(q.limit) : undefined;
    const texte = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 120) : undefined);
    const targetId = texte(q.targetId);
    const entries = await deps.journal.list(tenant, {
      ...(limit !== undefined ? { limit } : {}),
      ...(targetId ? { targetId } : {}),
      ...(texte(q.q) ? { q: texte(q.q)! } : {}),
      ...(texte(q.acteur) ? { acteur: texte(q.acteur)! } : {}),
      ...(texte(q.telephone) ? { telephone: texte(q.telephone)! } : {}),
    });
    return reply.code(200).send({ entries });
  });

  /**
   * Le journal des erreurs de livraison : ce que Meta a répondu quand un message n'est pas parti ou pas arrivé.
   * Lecture seule. Il porte les numéros, contrairement au journal des actions (« quel message » sans « à qui » ne
   * répond à rien) ; il se lit depuis les destinataires de campagne, les échecs de scénario et de messages libres,
   * et disparaît avec le contact purgé. Les appels en échec vers les systèmes du client : `/erreurs-systeme`.
   */
  app.get('/tenants/:tenantId/erreurs-livraison', optsEncadrement, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const q = (req.query ?? {}) as { limit?: unknown; q?: unknown; telephone?: unknown; code?: unknown };
    const limit = Number.isFinite(Number(q.limit)) ? Number(q.limit) : undefined;
    const texte = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 120) : undefined);
    // Un code non numérique est ignoré plutôt que refusé : il vient d'un champ de recherche, où l'on tape ce
    // qu'on a sous la main. `q` couvre déjà la recherche libre.
    const code = Number.isInteger(Number(q.code)) && String(q.code).trim() !== '' ? Number(q.code) : undefined;
    const erreurs = await deps.erreurs.lister(tenant, {
      ...(limit !== undefined ? { limit } : {}),
      ...(texte(q.q) ? { q: texte(q.q)! } : {}),
      ...(texte(q.telephone) ? { telephone: texte(q.telephone)! } : {}),
      ...(code !== undefined ? { code } : {}),
    });
    return reply.code(200).send({ erreurs });
  });

  /**
   * La moitié système du journal : les appels vers les systèmes du client qui n'ont pas abouti. Route à part :
   * les deux moitiés n'ont ni la même nature ni les mêmes colonnes. Elle nomme les systèmes internes d'un client
   * et leurs réponses.
   */
  app.get('/tenants/:tenantId/erreurs-systeme', optsEncadrement, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const q = (req.query ?? {}) as { limit?: unknown };
    const limit = Number.isFinite(Number(q.limit)) ? Number(q.limit) : undefined;
    return reply.code(200).send({ erreurs: await deps.erreurs.listerEchecsSysteme(tenant, limit) });
  });

  /**
   * 🔴 Suppression d'un contact : la seule, et elle efface pour de vrai. Irréversible, et elle peut viser des
   * milliers de fiches par filtres : le corps doit porter `confirm: 'SUPPRIMER'`. Le journal enregistre
   * l'identifiant, jamais le numéro (qui réinscrirait la personne dans une table jamais modifiée).
   */
  app.post('/tenants/:tenantId/contacts/purge', couteux, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const b = (req.body ?? {}) as { target?: unknown; confirm?: unknown };
    if (b.confirm !== 'SUPPRIMER') {
      return reply.code(400).send({ error: "suppression irréversible : envoyer confirm: 'SUPPRIMER' pour confirmer" });
    }
    const target = parseBulkTarget(b.target);
    if (target === null) return reply.code(400).send({ error: 'cible invalide (target: { ids } ou { filters, excludeIds })' });
    const ids = await deps.contacts.contactIdsForTarget(tenant, target);
    if (ids.length === 0) return reply.code(200).send({ purges: 0, conversations: 0, messages: 0, analyses: 0 });
    const { listeAgent, ...res } = await deps.contacts.purgeMany(tenant, ids);
    for (const id of ids) await journal(tenant, req, 'contact.purged', { kind: 'contact', id }, { lot: ids.length });
    /**
     * La réponse part d'abord, le retrait chez Meta ensuite, au mieux : un appel par contact (avec rejeu) avant la
     * réponse pouvait dépasser le délai de Cloudflare sur une grosse purge, et l'écran annonçait un échec pour des
     * données effacées. Après la validation, jamais dedans : un appel à Meta retiendrait la transaction ouverte.
     */
    reply.code(200).send(res);
    // La fonction `async` enveloppe aussi une levée synchrone : aucune promesse rejetée ne reste sans gestionnaire.
    void deps.enVol.suivre((async () => {
      try {
        await deps.listeDeLAgent.oublierChezMeta(tenant, listeAgent);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`purge : retrait chez Meta des contacts purgés en échec (${tenant}) :`, messageDe(err));
      }
    })());
    return reply;
  });
}
