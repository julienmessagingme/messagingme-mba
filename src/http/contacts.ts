import type { FastifyInstance } from 'fastify';
import { forbidNonAdmin, gardeEtendue, makeRequireRole } from '../auth/middleware';
import type { Guard, PreHandler } from '../auth/middleware';
import type { ContactRow, ContactFilters, BulkTarget, BulkEdits } from '../crm/contact-store.pg';
import type { UserFieldDef } from '../crm/types';
import type { ContactHistory, ContactSend } from '../crm/contact-history.pg';
import type { CoutContact, NiveauEngagement } from '../stats/cost';
import { validateFieldValue, canonicalizeFieldValue, socleField } from '../crm/fields';
import { classerDemandeArret } from '../crm/consentement';
import { scopeTenant } from './scope';
import { buildContactFilters, normalizeFieldFilters } from '../crm/contact-filters';
import { makeJournal, type AuditSink } from '../audit/journal';
import type { AuditEntry } from '../audit/store.pg';

export interface ContactsRouteDeps {
  /** Applique fields (MERGE) + suppression de fields + Nom + addTags/removeTags en une transaction. null si le
   *  contact n'existe pas (tenant). */
  applyEdits(
    tenantId: string,
    contactId: string,
    edits: {
      fields: Record<string, string>; removeFields?: string[]; addTags: string[]; removeTags: string[];
      profileName?: string | null; optInStatus?: 'opted_in' | 'opted_out';
    },
  ): Promise<{ contact: ContactRow; addedTags: string[] } | null>;
  /**
   * MODÉRATION : bloque ou débloque un contact. Bloqué = plus aucun envoi, et sa conversation disparaît de
   * l'inbox. Optionnelles : absentes, la modération n'est pas montée (503).
   */
  setBlocked?(tenantId: string, contactId: string, bloque: boolean, parUserId: string | null): Promise<boolean>;
  listBlocked?(tenantId: string): Promise<Array<{ id: string; profileName: string | null; phoneE164: string | null; blockedAt: string }>>;
  /**
   * Les contacts qui ont demandé à ne plus être contactés. Absente -> 503, jamais une liste vide : « aucun
   * désabonné » et « la liste n'est pas branchée » sont deux situations opposées, et la seconde est un
   * défaut de câblage qu'on ne doit pas afficher comme une bonne nouvelle.
   */
  listeDesabonnes?(tenantId: string): Promise<Array<{
    id: string; profileName: string | null; phoneE164: string | null; desabonneLe: string | null; source: string | null;
  }>>;
  /** Les messages entrants récents à relire avec la règle ÉLARGIE. Cf. `PgContactStore.messagesARelire`. */
  messagesARelire?(tenantId: string): Promise<{
    scannes: number;
    messages: Array<{ messageId: string; conversationId: string; contactId: string | null; waId: string; profileName: string | null; body: string; recuLe: string }>;
  }>;
  /** Action en masse (tags +/- et/ou poser un champ) sur une cible (ids ou filtres). Renvoie le nb touché. */
  applyEditsMany(tenantId: string, target: BulkTarget, edits: BulkEdits): Promise<number>;
  /**
   * SUPPRESSION : efface le contenu (fil, messages, analyse qualitative) et anonymise ce qui porte les
   * compteurs. Irréversible. Optionnelle : absente -> la route répond 503 au lieu de faire semblant.
   */
  purgeMany?(tenantId: string, ids: readonly string[]): Promise<{ purges: number; conversations: number; messages: number; analyses: number }>;
  /** Résout une cible (ids OU filtres) en identifiants. Nécessaire à la purge, qui travaille par identifiants. */
  contactIdsForTarget?(tenantId: string, target: BulkTarget): Promise<string[]>;
  /**
   * Journal d'audit. Optionnel : absent -> aucune trace (câblages de test). BEST-EFFORT à l'appel : un journal
   * en échec ne doit jamais faire échouer l'action métier qu'il observe.
   */
  audit?: AuditSink;
  /**
   * Lecture du journal. Séparée de l'écriture à dessein : le store est en AJOUT SEUL, et rien ici ne doit
   * laisser croire qu'une entrée se modifie. Optionnelle -> la route répond 503 plutôt qu'une liste vide,
   * qui se lirait comme « il ne s'est rien passé ».
   */
  listAudit?(tenantId: string, opts: { limit?: number; targetId?: string; q?: string; acteur?: string; telephone?: string }): Promise<AuditEntry[]>;
  /**
   * Le journal des ERREURS DE LIVRAISON. Séparé du journal d'actions, et pas par commodité : celui-ci porte
   * les numéros (sans eux il ne répond à rien), celui-là n'en porte jamais (y écrire un numéro annulerait la
   * purge d'un contact). Optionnel : absent -> 503, plutôt qu'une liste vide qui ferait croire qu'il n'y a
   * aucune erreur.
   */
  /**
   * La moitié SYSTÈME du journal des erreurs : les appels vers les systèmes du client qui n'ont pas abouti.
   *
   * ⚠️ Optionnelle, comme sa voisine : absente, la route rend 503 en le disant, plutôt que de rendre une
   * liste vide qui se lirait « tout va bien ».
   */
  listErreursSysteme?(tenantId: string, limit?: number): Promise<unknown[]>;
  listErreursLivraison?(tenantId: string, filtre: { limit?: number; q?: string; telephone?: string; code?: number }): Promise<unknown[]>;
  /** Définitions des user fields du tenant (pour valider clé + type d'une valeur saisie). */
  listUserFields(tenantId: string): Promise<UserFieldDef[]>;
  /**
   * Matérialise un champ SOCLE (`prenom`/`email`) absent de la base. Idempotent. Optionnelle : sans elle, le
   * comportement historique est conservé (refus « champ inconnu »), donc les câblages de test ne changent pas.
   */
  ensureSocleField?(tenantId: string, key: string, label: string, type: UserFieldDef['type']): Promise<void>;
  /**
   * Crée (ou met à jour) UN contact saisi à la main. Délègue au MÊME upsert que l'API publique et l'import :
   * un second chemin de création divergerait sur la normalisation du numéro, l'opt-in ou les champs.
   * Optionnelle : sans elle la route n'est pas montée (503), donc les câblages de test restent inchangés.
   */
  createOneContact?(
    tenantId: string,
    input: { phone: string; name?: string; fields?: Record<string, string>; tags?: string[]; optIn?: boolean; bsuid?: string },
  ): Promise<{ status: 'created' | 'updated' | 'error'; contactId?: string; reason?: string }>;
  /** Envois reçus + conversations tenues par ce contact. null si le contact n'est pas dans le tenant. */
  getContactHistory(tenantId: string, contactId: string): Promise<ContactHistory | null>;
  /** Envois du contact pour l'export CSV (non capé). null si le contact n'est pas dans le tenant. */
  listSendsForExport(tenantId: string, contactId: string): Promise<ContactSend[] | null>;
  /**
   * CE QU'UN CONTACT A COÛTÉ, et jusqu'où il est allé (2026-09-11).
   *
   * OPTIONNELLE : absente, la route rend 503 plutôt que d'exister sans rien dire. Elle appelle Meta pour les
   * tarifs, donc une instance sans jeton ne peut pas la servir, et la fiche contact doit continuer de
   * s'ouvrir sans elle.
   */
  getBilanContact?(tenantId: string, contactId: string): Promise<{ cout: CoutContact; entonnoir: NiveauEngagement[] } | null>;
  /**
   * Signale qu'un tag vient d'être posé sur UN contact, pour les automations « tag ajouté » (E.2). Best-effort :
   * l'édition de la fiche a déjà réussi, un échec ici ne doit pas la faire échouer.
   *
   * Volontairement absent de l'action EN MASSE et de l'import : poser un tag sur des milliers de contacts
   * déclencherait autant de scénarios, donc autant de messages facturés. Pour toucher une liste, c'est la
   * campagne. Absent -> aucune émission (rétro-compatible).
   */
  emitTagAdded?(tenantId: string, contactId: string, tags: string[]): Promise<void>;
}

/** Borne les listes d'ids d'une action en masse (dédup, non vides). Au-delà du plafond, on tronque
 *  (le front vise plutôt `{filters, excludeIds}` que d'envoyer 100k ids). */
const asIdArray = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.map(String).map((s) => s.trim()).filter((s) => s !== ''))].slice(0, 100_000) : [];

/** Normalise un ContactFilters depuis un corps JSON (donnée cliente). Le corps porte des TABLEAUX là où les
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
    fieldFilters: Array.isArray(r.fieldFilters) ? normalizeFieldFilters(r.fieldFilters) : [],
  });
}

/**
 * Cible d'une action en masse depuis le corps : `ids` non vides -> par ids ; sinon `filters` (+ `excludeIds`).
 * null si aucune cible exploitable (-> 400, jamais un UPDATE global par erreur).
 *
 * EXPORTÉE parce que la création de campagne s'en sert aussi (elle désigne ses destinataires exactement de la
 * même façon depuis le 2026-09-01). Un second analyseur dériverait, et une cible qui dérive veut dire une
 * campagne qui ne vise pas ce que l'écran du mini-CRM montrait.
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
 * Édition d'UN contact (admin-only) : ajouter/mettre à jour des valeurs de user fields + affecter/retirer
 * des tags, depuis la fiche. Le tenant vient du JWT. MERGE (n'écrase jamais les autres clés). Renvoie le
 * contact à jour. Valide chaque valeur selon le type déclaré du user field (clé inconnue / valeur invalide -> 400).
 */
/**
 * Définition d'un champ pour valider une valeur saisie. Un champ SOCLE (`prenom`/`email`) absent est MATÉRIALISÉ
 * à la volée : l'écran le propose dès l'ouverture d'un espace, alors qu'aucun chemin d'inscription ne le créait
 * en base (bug vécu le 2026-08-17, « champ inconnu : prenom » sur un compte neuf). Tout autre champ inconnu
 * reste REFUSÉ : c'est la garde qui empêche une faute de frappe de créer un champ fantôme.
 */
async function defPourEcriture(deps: ContactsRouteDeps, tenantId: string, key: string): Promise<UserFieldDef | undefined> {
  const lu = async (): Promise<UserFieldDef | undefined> => (await deps.listUserFields(tenantId)).find((d) => d.key === key);
  const def = await lu();
  if (def) return def;
  const socle = socleField(key);
  if (!socle || !deps.ensureSocleField) return undefined;
  await deps.ensureSocleField(tenantId, socle.key, socle.label, socle.type);
  return lu();
}

export function registerContacts(app: FastifyInstance, deps: ContactsRouteDeps, garde: Guard, limiteCouteuse?: PreHandler): void {
  const opts = { preHandler: garde };
  /**
   * L'ENCADREMENT, ET PAS TOUT LE MONDE : `admin` et `manager`. La liste des désabonnés nomme des personnes
   * avec leur numéro ; c'est un artefact de conformité, pas un outil de traitement quotidien.
   *
   * 🔴 ELLE A ÉTÉ INERTE UNE JOURNÉE, ET C'EST CE QUE LA REVUE DU CHANTIER A TROUVÉ : `AppShell` renvoyait à
   * l'inbox tout compte non-admin, sur toute page, donc aucun manager n'atteignait cet écran. Tranché par
   * Julien le 2026-09-14 (« ouvre la console aux managers sur les écrans de conformité ») : la console et
   * le serveur bougent désormais ensemble, et `web/lib/nav.ts` porte la liste des écrans ouverts.
   *
   * ⚠️ ELLE COUVRE LES LECTURES DE CONFORMITÉ, ET ELLES SEULES : les désabonnés, les refus possibles, le
   * journal des actions et les deux moitiés du journal des erreurs. Consulter n'est pas décider : brancher
   * un connecteur sur le consentement, purger un contact ou bloquer quelqu'un restent `forbidNonAdmin`.
   */
  const optsEncadrement = gardeEtendue(garde, makeRequireRole(['admin', 'manager']));
  // Garde des routes coûteuses : la garde habituelle, PLUS le plafond par espace (chaîne APLATIE).
  const couteux = gardeEtendue(garde, limiteCouteuse);
  const journal = makeJournal(deps.audit);

  /**
   * Contacts bloqués du tenant. Cette liste est la SEULE porte de sortie d'un blocage : sans elle, un contact
   * bloqué, invisible dans l'inbox et injoignable par campagne, serait perdu pour de bon.
   *
   * Déclarée AVANT `/contacts/:contactId` : `blocked` n'est pas un identifiant de contact.
   */
  /**
   * LES CONTACTS DÉSABONNÉS : la liste du centre de Sécurité & compliance.
   *
   * 🔴 RÉSERVÉE À L'ENCADREMENT (`admin` et `manager`). Elle nomme des personnes qui ont demandé qu'on les
   * laisse tranquilles, avec leur numéro : c'est une liste de conformité, pas un outil de travail
   * quotidien. Même garde que le récap du bot d'aide, et pour la même raison.
   *
   * ⚠️ `tenant_id = $1` dans la requête, EN PLUS de `scopeTenant` : le pooler est superuser, la RLS est
   * contournée, et le filtrage en code est donc le seul contrôle.
   */
  app.get('/tenants/:tenantId/contacts/desabonnes', optsEncadrement, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!deps.listeDesabonnes) return reply.code(503).send({ error: 'liste des désabonnés indisponible' });
    return reply.code(200).send({ contacts: await deps.listeDesabonnes(tenant) });
  });

  /**
   * LES REFUS POSSIBLES À CONFIRMER : ce que la règle ÉLARGIE aurait attrapé, et qu'elle n'a PAS appliqué.
   *
   * 🔴 ELLE N'A DÉSABONNÉ PERSONNE, ET CETTE ROUTE N'ÉCRIT RIEN. Mesure du 2026-09-13 : sur 135 messages
   * entrants réels, zéro reconnu par la règle qui agit comme par une règle élargie candidate. Il n'y a rien
   * sur quoi calibrer, donc on instrumente d'abord et on décide ensuite. Cette liste EST l'instrument.
   *
   * ⚠️ LE PLAFOND DE MESSAGES SCANNÉS EST REMONTÉ TEL QUEL (`scannes`), pour que l'écran puisse dire sur
   * quoi il a regardé. Une liste vide obtenue en n'ayant rien lu et une liste vide obtenue après avoir tout
   * lu ne veulent pas dire la même chose.
   */
  app.get('/tenants/:tenantId/contacts/refus-possibles', optsEncadrement, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!deps.messagesARelire) return reply.code(503).send({ error: 'relecture des refus indisponible' });
    const { scannes, messages } = await deps.messagesARelire(tenant);
    // La règle vit dans `src/crm/consentement.ts`, avec ses tests. Elle n'est PAS recopiée ici.
    const refus = messages.filter((m) => classerDemandeArret(m.body) === 'peut_etre');
    return reply.code(200).send({ scannes, refus });
  });

  app.get('/tenants/:tenantId/contacts/blocked', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!deps.listBlocked) return reply.code(503).send({ error: 'modération indisponible' });
    return reply.code(200).send({ contacts: await deps.listBlocked(tenant) });
  });

  /**
   * Bloque ou débloque un contact. Admin seulement : c'est une décision qui coupe la relation avec un client,
   * et qui doit rester traçable à une personne.
   */
  app.patch('/tenants/:tenantId/contacts/:contactId/blocked', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    if (!deps.setBlocked) return reply.code(503).send({ error: 'modération indisponible' });
    const bloque = (req.body as { blocked?: unknown } | null)?.blocked;
    if (typeof bloque !== 'boolean') return reply.code(400).send({ error: 'blocked (booléen) requis' });
    const { contactId } = req.params as { contactId: string };
    const ok = await deps.setBlocked(tenant, contactId, bloque, req.auth?.userId ?? null);
    if (!ok) return reply.code(404).send({ error: 'contact inconnu' });
    return reply.code(200).send({ contactId, blocked: bloque });
  });

  app.patch('/tenants/:tenantId/contacts/:contactId', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
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
    // est inoffensif et scopé). On accepte donc les clés SANS définition (champ « orphelin » dont le def a été
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

    // Consentement posé à la main depuis la fiche. DEUX valeurs seulement : « inconnu » veut dire « rien n'a
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

    // Une transaction : MERGE/suppression fields + Nom + tags, ou 404 si le contact n'est pas dans le tenant.
    const updated = await deps.applyEdits(tenant, contactId, {
      fields: values, removeFields, addTags, removeTags,
      ...(profileName !== undefined ? { profileName } : {}),
      ...(optInStatus !== undefined ? { optInStatus } : {}),
    });
    if (!updated) return reply.code(404).send({ error: 'contact inconnu' });
    // Journalisé comme la bascule en masse : c'est la même décision, prise sur une fiche au lieu d'une liste.
    // APRÈS l'écriture réussie, sinon on consignerait un consentement qu'on n'a pas posé.
    if (optInStatus !== undefined) {
      await journal(tenant, req, optInStatus === 'opted_in' ? 'contact.optin' : 'contact.optout', { kind: 'contact', id: contactId }, { source: 'fiche' });
    }
    // Automations « tag ajouté » (E.2), sur les tags RÉELLEMENT nouveaux : reposer un tag déjà présent ne
    // change rien en base, le déclencheur ne doit donc pas partir. APRÈS l'écriture réussie et en best-effort
    // (un incident de file ne transforme pas une édition de fiche réussie en erreur pour l'opérateur), mais
    // l'échec est JOURNALISÉ : sans trace, une automation muette serait indébogable.
    if (updated.addedTags.length > 0 && deps.emitTagAdded) {
      await deps.emitTagAdded(tenant, contactId, updated.addedTags).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error('emitTagAdded ignoré (best-effort):', err instanceof Error ? err.message : err);
      });
    }
    return reply.code(200).send({ contact: updated.contact });
  });

  /**
   * Historique d'un contact : campagnes reçues et conversations tenues. Lecture seule.
   *
   * Le segment `/history` n'est pas décoratif : un `GET /tenants/:t/contacts/:contactId` nu entrerait en
   * concurrence de routage avec les GET statiques `/contacts/count` et `/contacts/ids` de src/http/import.ts.
   * Fastify tranche en faveur du statique, mais c'est une ambiguïté gratuite.
   *
   * Admin-only, comme tout ce fichier (`registerContacts` est monté avec `gardeAdmin`). Un agent voit déjà
   * les mêmes conversations dans l'inbox, mais pas l'historique de campagnes, qui est une vue de pilotage.
   */
  app.get('/tenants/:tenantId/contacts/:contactId/history', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { contactId } = req.params as { contactId: string };
    const history = await deps.getContactHistory(tenant, contactId);
    if (!history) return reply.code(404).send({ error: 'contact inconnu' });
    return reply.code(200).send(history);
  });

  /**
   * LE BILAN d'un contact : ce qu'il a coûté, et son entonnoir d'engagement (demande de Julien,
   * 2026-09-11 : « mettre le fric que la personne nous a coûté et en face le nombre d'engagements de 1er
   * niveau [...] puis de 2e niveau, 3e niveau »).
   *
   * ⚠️ ROUTE À PART DE `/history`, alors que l'écran les affiche ensemble, et pour une raison qui compte :
   * celle-ci appelle META pour les tarifs. La fiche contact s'ouvre souvent juste pour corriger un champ, et
   * faire dépendre son historique d'un aller-retour réseau chez Meta transformerait une lecture locale en
   * lecture distante. Les deux partent en parallèle depuis l'écran.
   */
  app.get('/tenants/:tenantId/contacts/:contactId/bilan', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { contactId } = req.params as { contactId: string };
    if (!deps.getBilanContact) return reply.code(503).send({ error: 'bilan indisponible sur cette instance' });
    const bilan = await deps.getBilanContact(tenant, contactId);
    if (!bilan) return reply.code(404).send({ error: 'contact inconnu' });
    return reply.code(200).send(bilan);
  });

  /**
   * Envois du contact pour l'EXPORT CSV (F5), non capé. Renvoie du JSON `{ sends: [...] }` (le front construit et
   * télécharge le CSV : le wrapper `request()` fait toujours res.json(), donc pas de CSV brut côté serveur). Admin-only.
   */
  app.get('/tenants/:tenantId/contacts/:contactId/history/export', couteux, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { contactId } = req.params as { contactId: string };
    const sends = await deps.listSendsForExport(tenant, contactId);
    if (!sends) return reply.code(404).send({ error: 'contact inconnu' });
    /**
     * 🔴 UNE EXTRACTION DE DONNÉES PERSONNELLES NE LAISSAIT AUCUNE TRACE (choix de Julien, 2026-09-15). Ce
     * qui sort d'ici, c'est l'historique d'envois d'une personne, destiné à un fichier qui vit ensuite hors
     * du produit. C'est précisément le geste qu'un DPO veut pouvoir retracer.
     *
     * ⚠️ LE NOMBRE, PAS LE CONTENU : le détail dit combien de lignes sont parties, jamais lesquelles. Les y
     * écrire recopierait dans une table jamais purgée ce que l'export est censé simplement montrer.
     */
    await journal(tenant, req, 'contact.exporte', { kind: 'contact', id: contactId }, { envois: sends.length });
    return reply.code(200).send({ sends });
  });

  /**
   * Action en masse (mini-CRM, admin-only) : ajouter/retirer un tag OU poser la valeur d'un champ sur une
   * cible (ids cochés OU filtres + exclusions). Une seule action par appel. Le champ est validé contre les
   * définitions user_fields du tenant (clé inconnue -> 400 ; valeur invalide pour le type -> 400, comme la
   * fiche). La cible est toujours re-scopée `tenant_id` + `deleted_at is null` côté store. Renvoie `{ affected }`.
   */
  /**
   * Crée UN contact à la main (le mini-CRM ne savait le faire que par import CSV : fabriquer un fichier pour un
   * seul numéro). Admin-only, tenant du JWT. Délègue à l'upsert partagé, donc le numéro est normalisé comme
   * ailleurs et un numéro DÉJÀ connu met le contact à jour au lieu d'échouer : la réponse dit lequel des deux
   * s'est produit (`status`), pour que l'écran ne prétende pas avoir créé ce qui existait déjà.
   */
  app.post('/tenants/:tenantId/contacts', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    if (!deps.createOneContact) return reply.code(503).send({ error: 'création de contact non configurée' });
    const b = (req.body ?? {}) as { phone?: unknown; name?: unknown; fields?: unknown; tags?: unknown; optIn?: unknown; bsuid?: unknown };
    const phone = typeof b.phone === 'string' ? b.phone.trim() : '';
    if (phone === '') return reply.code(400).send({ error: 'téléphone requis' });
    const rawFields = b.fields && typeof b.fields === 'object' && !Array.isArray(b.fields) ? (b.fields as Record<string, unknown>) : {};

    // Les champs sont validés ICI contre les définitions du tenant, alors que l'upsert partagé auto-créerait
    // toute clé inconnue. C'est voulu : une saisie à la main ne doit pas pouvoir inventer un champ, sinon une
    // faute de frappe crée un champ fantôme pour tout l'espace. Un champ SOCLE absent est matérialisé.
    const fields: Record<string, string> = {};
    for (const [key, raw] of Object.entries(rawFields)) {
      const val = String(raw ?? '').trim();
      if (val === '') continue;
      const def = await defPourEcriture(deps, tenant, key);
      if (!def) return reply.code(400).send({ error: `champ inconnu : ${key}` });
      if (!validateFieldValue(def.type, val)) return reply.code(400).send({ error: `valeur invalide pour « ${def.label} » (${def.type})` });
      fields[key] = canonicalizeFieldValue(def.type, val);
    }

    // OPT-IN PAR DÉFAUT, et seulement ici. Saisir un numéro à la main suppose qu'on l'a obtenu de la personne ;
    // le créer muet en ferait un contact que le garde-fou de campagne ÉCARTE du marketing (il exige un opt-in
    // explicite), sans que rien ne le dise à l'écran. L'import CSV et l'API publique gardent l'exigence inverse :
    // là, l'opérateur charge une liste dont il ne connaît pas chaque ligne. Décision de Julien, 2026-08-18.
    //
    // Calculé UNE fois : la valeur sert à créer le contact ET à le journaliser. Deux expressions séparées ont
    // divergé le temps d'un déploiement, et le journal annonçait « optIn: non » sur un contact opt-in.
    const optIn = b.optIn !== false;

    const name = typeof b.name === 'string' && b.name.trim() !== '' ? b.name.trim().slice(0, 120) : undefined;
    const res = await deps.createOneContact(tenant, {
      phone,
      ...(name ? { name } : {}),
      ...(Object.keys(fields).length > 0 ? { fields } : {}),
      tags: asStringArray(b.tags),
      optIn,
      // Facultatif, et surtout PAS une seconde identité obligatoire : le numéro reste la clé de ce chemin.
      ...(typeof b.bsuid === 'string' && b.bsuid.trim() !== '' ? { bsuid: b.bsuid.trim().slice(0, 200) } : {}),
    });
    if (res.status === 'error') return reply.code(400).send({ error: res.reason ?? 'contact invalide' });
    // Le détail dit `updated` quand le numéro était déjà connu : sans ça, l'historique laisserait croire à une
    // création alors que la fiche existait. L'opt-in figure ici plutôt que sur une ligne `contact.optin` à part,
    // parce qu'il n'y a eu qu'UNE action de l'opérateur.
    await journal(tenant, req, 'contact.created', { kind: 'contact', id: res.contactId ?? 'inconnu' }, { status: res.status, optIn });
    return reply.code(res.status === 'created' ? 201 : 200).send({ status: res.status, contactId: res.contactId });
  });

  app.post('/tenants/:tenantId/contacts/bulk', couteux, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;

    const b = (req.body ?? {}) as { target?: unknown; action?: unknown };
    const target = parseBulkTarget(b.target);
    if (target === null) return reply.code(400).send({ error: 'cible invalide (target: { ids } ou { filters, excludeIds })' });
    const action = (b.action ?? {}) as { type?: unknown; tags?: unknown; key?: unknown; value?: unknown };

    if (action.type === 'add_tag' || action.type === 'remove_tag') {
      const tags = asStringArray(action.tags);
      if (tags.length === 0) return reply.code(400).send({ error: 'tag(s) requis' });
      const edits: BulkEdits = action.type === 'add_tag' ? { addTags: tags } : { removeTags: tags };
      const affected = await deps.applyEditsMany(tenant, target, edits);
      return reply.code(200).send({ affected });
    }

    if (action.type === 'set_field') {
      const key = typeof action.key === 'string' ? action.key.trim() : '';
      if (key === '') return reply.code(400).send({ error: 'champ requis (key)' });
      const def = await defPourEcriture(deps, tenant, key);
      if (!def) return reply.code(400).send({ error: `champ inconnu : ${key}` });
      const val = String(action.value ?? '');
      if (!validateFieldValue(def.type, val)) return reply.code(400).send({ error: `valeur invalide pour « ${def.label} » (${def.type})` });
      const affected = await deps.applyEditsMany(tenant, target, { setField: { key, value: canonicalizeFieldValue(def.type, val) } });
      return reply.code(200).send({ affected });
    }

    if (action.type === 'set_optin') {
      // Seul chemin capable de poser `opted_out` : l'import et l'API publique ne font jamais régresser un
      // statut. C'est donc ici qu'un « ne m'envoyez plus rien » devient exécutoire pour les campagnes.
      const value = action.value === 'opted_in' || action.value === 'opted_out' ? action.value : null;
      if (value === null) return reply.code(400).send({ error: 'valeur requise (opted_in | opted_out)' });
      const affected = await deps.applyEditsMany(tenant, target, { setOptIn: value });
      await journal(tenant, req, value === 'opted_in' ? 'contact.optin' : 'contact.optout', { kind: 'contact', id: 'lot' }, { affected });
      return reply.code(200).send({ affected });
    }

    return reply.code(400).send({ error: 'action inconnue (add_tag | remove_tag | set_field | set_optin)' });
  });

  /**
   * Historique d'audit de l'espace, du plus récent au plus ancien. Lecture seule, admin-only.
   *
   * Monté ici et pas dans un fichier à part : toutes les actions journalisées sont des actions de CONTACT,
   * et ce fichier est déjà leur périmètre admin. `targetId` filtre sur un contact précis (fiche).
   */
  app.get('/tenants/:tenantId/audit', optsEncadrement, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!deps.listAudit) return reply.code(503).send({ error: 'journal indisponible sur cette instance' });
    const q = (req.query ?? {}) as { limit?: unknown; targetId?: unknown; q?: unknown; acteur?: unknown; telephone?: unknown };
    const limit = Number.isFinite(Number(q.limit)) ? Number(q.limit) : undefined;
    const texte = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 120) : undefined);
    const targetId = texte(q.targetId);
    const entries = await deps.listAudit(tenant, {
      ...(limit !== undefined ? { limit } : {}),
      ...(targetId ? { targetId } : {}),
      ...(texte(q.q) ? { q: texte(q.q)! } : {}),
      ...(texte(q.acteur) ? { acteur: texte(q.acteur)! } : {}),
      ...(texte(q.telephone) ? { telephone: texte(q.telephone)! } : {}),
    });
    return reply.code(200).send({ entries });
  });

  /**
   * LE JOURNAL DES ERREURS DE LIVRAISON : ce que Meta a répondu quand un message n'est pas parti, ou n'est pas
   * arrivé. Lecture seule, admin-only, au même endroit que le journal des actions.
   *
   * ⚠️ Il porte les NUMÉROS, contrairement au journal des actions, et c'est délibéré : « quel message n'est pas
   * arrivé » sans dire « à qui » ne répond à rien. Il n'a rien d'immuable, il se lit depuis les destinataires
   * de campagne, et il disparaît avec le contact quand on le purge.
   */
  app.get('/tenants/:tenantId/erreurs-livraison', optsEncadrement, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!deps.listErreursLivraison) return reply.code(503).send({ error: 'journal des erreurs indisponible sur cette instance' });
    const q = (req.query ?? {}) as { limit?: unknown; q?: unknown; telephone?: unknown; code?: unknown };
    const limit = Number.isFinite(Number(q.limit)) ? Number(q.limit) : undefined;
    const texte = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 120) : undefined);
    // Un code non numérique est IGNORÉ plutôt que refusé : il vient d'un champ de recherche, où l'on tape ce
    // qu'on a sous la main. `q` couvre déjà la recherche libre.
    const code = Number.isInteger(Number(q.code)) && String(q.code).trim() !== '' ? Number(q.code) : undefined;
    const erreurs = await deps.listErreursLivraison(tenant, {
      ...(limit !== undefined ? { limit } : {}),
      ...(texte(q.q) ? { q: texte(q.q)! } : {}),
      ...(texte(q.telephone) ? { telephone: texte(q.telephone)! } : {}),
      ...(code !== undefined ? { code } : {}),
    });
    return reply.code(200).send({ erreurs });
  });

  /**
   * LA MOITIÉ SYSTÈME DU JOURNAL : les appels vers VOS systèmes qui n'ont pas abouti (migration 0142).
   *
   * 🔴 UNE ROUTE À PART, ET PAS UN CHAMP DE PLUS SUR LA PRÉCÉDENTE. Les deux moitiés sont de NATURE
   * différente (Meta refuse un message vers un contact / le système du client refuse un appel que nous lui
   * passons), elles n'ont pas les mêmes colonnes, et les fondre obligerait chacune à porter les champs vides
   * de l'autre. L'écran les montre côte à côte, distinguées, pas mélangées.
   *
   * ⚠️ ADMIN-ONLY, comme la précédente : elle nomme les systèmes internes d'un client et ce qu'ils ont
   * répondu.
   */
  app.get('/tenants/:tenantId/erreurs-systeme', optsEncadrement, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!deps.listErreursSysteme) return reply.code(503).send({ error: 'journal système indisponible sur cette instance' });
    const q = (req.query ?? {}) as { limit?: unknown };
    const limit = Number.isFinite(Number(q.limit)) ? Number(q.limit) : undefined;
    return reply.code(200).send({ erreurs: await deps.listErreursSysteme(tenant, limit) });
  });

  /**
   * SUPPRESSION d'un contact : la SEULE, et elle efface pour de vrai.
   *
   * Il a existé deux destructions, une douce (réversible, qui gardait le fil) et celle-ci. Les distinguer à
   * l'écran ne servait personne : on supprime un contact pour qu'il disparaisse, pas pour qu'il disparaisse
   * à moitié. Décision de Julien le 2026-08-19, après avoir supprimé un contact dont la conversation restait.
   *
   * Le corps doit porter `confirm: 'SUPPRIMER'`. Ce n'est pas de la décoration : l'action est irréversible et
   * peut viser des milliers de fiches d'un coup via des filtres.
   *
   * ⚠️ Le journal enregistre l'IDENTIFIANT du contact, jamais son numéro : y écrire le numéro annulerait la
   * purge, en réinscrivant la personne dans une table faite pour ne jamais être modifiée.
   */
  app.post('/tenants/:tenantId/contacts/purge', couteux, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const b = (req.body ?? {}) as { target?: unknown; confirm?: unknown };
    if (b.confirm !== 'SUPPRIMER') {
      return reply.code(400).send({ error: "suppression irréversible : envoyer confirm: 'SUPPRIMER' pour confirmer" });
    }
    const target = parseBulkTarget(b.target);
    if (target === null) return reply.code(400).send({ error: 'cible invalide (target: { ids } ou { filters, excludeIds })' });
    if (!deps.purgeMany || !deps.contactIdsForTarget) {
      return reply.code(503).send({ error: 'suppression indisponible sur cette instance' });
    }
    const ids = await deps.contactIdsForTarget(tenant, target);
    if (ids.length === 0) return reply.code(200).send({ purges: 0, conversations: 0, messages: 0, analyses: 0 });
    const res = await deps.purgeMany(tenant, ids);
    for (const id of ids) await journal(tenant, req, 'contact.purged', { kind: 'contact', id }, { lot: ids.length });
    return reply.code(200).send(res);
  });
}
