import type { Pool } from 'pg';
import { enTransaction } from '../db/transaction';
import { PEREMPTION_WHATSAPP_MS } from '../contacts/joignabilite';
import type { NiveauRisque, RaisonRisque } from '../engagement/risque';
import type { ContactStore, ContactUpsert, ContactDeLot, LotContacts } from './import';
import { classifyWaId, waIdOf } from './identity';
import { messageDe } from '../lib/erreur';
import type { LigneDeLaListe } from '../mba/liste';
import type { CleFicheFixe } from './champs-fiche';
import { clauseFiltreFiche, estCleFiltrable, estOperateurFicheSeul, type OperateurFicheSeul } from './filtre-fiche';
import { COLONNES_ANALYSE_FICHE, analyseDeLaLigne, type AnalyseDeFiche, type LigneAnalyseFiche } from '../analysis/fiche';

export interface ContactRow {
  id: string;
  phoneE164: string | null;
  /** Identité BSUID (business-scoped user id) quand le contact n'a pas de numéro. */
  bsuid: string | null;
  /**
   * L'identifiant de l'outil du client, posé par l'API publique ; `null` = aucun. Il sert à retrouver la fiche et
   * à réécrire dans l'outil qui l'a donné, jamais d'adresse d'envoi.
   */
  externalId: string | null;
  profileName: string | null;
  optInStatus: string;
  fields: Record<string, unknown>;
  tags: string[];
  createdAt: string;
  /** Date de blocage (modération). `null` = non bloqué. Bloqué : plus aucun envoi, conversation masquée. */
  blockedAt: string | null;
  /**
   * Joignabilité WhatsApp mesurée, et sa date : les deux voyagent toujours ensemble. Une valeur sans date ne
   * pourrait pas se périmer : la fiche lit donc `verdictWhatsApp`, qui rend alors `inconnu`, jamais la valeur seule.
   */
  whatsappJoignable: boolean | null;
  whatsappJoignableLe: string | null;
  /**
   * Le risque de désengagement, écrit par le seul balayage de nuit. `null` = jamais calculé : la console affiche
   * alors « pas encore calculé ». Voir `RisqueContact`.
   */
  risque: RisqueContact | null;
}

/**
 * Le risque de désengagement d'une fiche, tel que la console le lit (fiche du mini-CRM). La forme publique de
 * la même donnée est `EngagementRisk` (`src/api/contacts-v1.ts`), en anglais : c'est un contrat d'API, celle-ci
 * ne sort pas de la console.
 */
export interface RisqueContact {
  niveau: NiveauRisque;
  /** `null` pour `inconnu`, et seulement pour lui (CHECK en base). */
  score: number | null;
  /** Les trois raisons les plus lourdes, en codes (`RAISONS_RISQUE`) : la console les traduit. */
  raisons: RaisonRisque[];
  /**
   * La date à laquelle la fiche est passée à ce niveau (« depuis le »). Une fiche dont le niveau ne change pas
   * garde sa date ; son score et ses raisons, eux, sont recalculés chaque nuit (`PgRisqueStore.ecrire`).
   */
  calculeLe: string;
}

/** Ce qu'il faut d'une fiche pour savoir quelles clés elle porte (`resoudreFiche`, `src/api/fiche.ts`). */
export interface FicheIdentite {
  id: string;
  externalId: string | null;
  phoneE164: string | null;
  bsuid: string | null;
}

/** Les clés d'une fiche, normalisées (numéro en E.164). L'appelant en donne au moins une. */
export interface ClesNormalisees {
  contactId?: string;
  externalId?: string;
  phoneE164?: string;
  bsuid?: string;
}

/** Une fiche créée ou retrouvée par l'index du numéro ou du BSUID, ou le refus d'un index d'unicité. */
export type CreationFiche = (FicheIdentite & { created: boolean }) | 'conflit';

/** Tout ce que `GET /v1/contacts/{contactId}` rend, lu en une requête. Dates en ISO. */
export interface FicheApiLigne {
  id: string;
  externalId: string | null;
  phoneE164: string | null;
  bsuid: string | null;
  profileName: string | null;
  fields: Record<string, unknown>;
  tags: string[];
  optInStatus: string;
  optInSource: string | null;
  optOutAt: string | null;
  rcsOptoutAt: string | null;
  blockedAt: string | null;
  whatsappJoignable: boolean | null;
  whatsappJoignableLe: string | null;
  /** Le risque de désengagement, écrit par le seul balayage. `null` = jamais calculé. */
  risqueNiveau: NiveauRisque | null;
  risqueScore: number | null;
  risqueRaisons: RaisonRisque[];
  risqueCalculeLe: string | null;
  /** La dernière analyse recopiée sur la fiche (0196), `null` si elle n'a jamais été analysée. Sans résumé. */
  analyse: AnalyseDeFiche | null;
  createdAt: string;
}

/**
 * La dernière analyse d'une fiche et le résumé de la MÊME analyse (celui de la conversation que la copie désigne,
 * `analyse_conversation_id`). `resume` à `null` : pas de copie, conversation effacée, ou analyse sans résumé. Sert
 * le MCP et l'outil « Lire la fiche » de l'agent IA ; jamais l'API publique (décision 15 : le résumé porte les
 * propos du client).
 */
export interface AnalyseEtResume {
  analyse: AnalyseDeFiche | null;
  resume: string | null;
}

/** Les colonnes de la copie, qualifiées, plus le résumé de sa conversation : un seul `select` pour les deux lecteurs. */
const SELECT_ANALYSE_ET_RESUME = `${COLONNES_ANALYSE_FICHE.map((k) => `c.${k}`).join(', ')}, a.summary as resume`;
/** 🔴 L'espace sur les DEUX tables : la conversation d'une copie appartient à la même fiche, mais le filtre ne le suppose pas. */
const JOINTURE_RESUME = 'left join conversation_analysis a on a.conversation_id = c.analyse_conversation_id and a.tenant_id = $1';

/**
 * Ce que l'API publique écrit sur une fiche déjà résolue (`editerFicheApi`). `profileName` : `undefined` = on
 * n'y touche pas, `null` = vider.
 */
export interface EditionFicheApi {
  fields: Record<string, string>;
  removeFields: string[];
  addTags: string[];
  removeTags: string[];
  profileName?: string | null;
}

/** Une violation d'index unique : un refus de saisie, pas une panne. */
const estUnicite = (err: unknown): boolean => (err as { code?: string }).code === '23505';

/** Opérateurs de filtre sur un champ perso (jsonb, valeur string). `eq`/`contains`/`not_contains` exigent
 *  une valeur ; `empty`/`not_empty` n'en prennent pas. */
export type ContactFieldOp = 'eq' | 'contains' | 'not_contains' | 'empty' | 'not_empty';

/** Whitelist des opérateurs de champ, partagée par le parsing des query params (GET) et du corps JSON (POST
 *  bulk) : pas de divergence entre les deux points d'entrée. */
export const CONTACT_FIELD_OPS: readonly ContactFieldOp[] = ['eq', 'contains', 'not_contains', 'empty', 'not_empty'];
export function isContactFieldOp(v: unknown): v is ContactFieldOp {
  return typeof v === 'string' && (CONTACT_FIELD_OPS as readonly string[]).includes(v);
}

/**
 * Un filtre sur la valeur d'un champ. `value` ignorée pour `empty`/`not_empty`. Sur une clé de la dernière analyse
 * (`src/crm/filtre-fiche.ts`), la colonne de la fiche, avec les opérateurs de son type ; sur toute autre clé, le
 * jsonb des champs perso, avec les opérateurs texte.
 */
export interface ContactFieldFilter { key: string; op: ContactFieldOp | OperateurFicheSeul; value: string }

/**
 * Résolution d'un contact à partir d'un `wa_id` : E.164 exact (`'+' || wa_id`), sinon chiffres nus, sinon BSUID ;
 * un seul contact, préférence à la correspondance exacte. Attend `$1` = tenant, `$2` = wa_id, derrière un
 * `where tenant_id = $1`. Règle de routage des messages entrants : une seule écriture, sinon les copies divergent.
 */
export function matchWaIdPredicat(contact: string, waId: string): string {
  return `(${contact}phone_e164 = '+' || ${waId} or regexp_replace(${contact}phone_e164, '[^0-9]', '', 'g') = ${waId} or ${contact}bsuid = ${waId})`;
}

export const MATCH_BY_WAID_SQL = `and ${matchWaIdPredicat('', '$2')}
       order by (phone_e164 = '+' || $2) desc limit 1`;

/** Critères composables de la « Liste de contacts » (source de campagne) et du mini-CRM, tous optionnels ; vides,
 *  aucun filtre (tous les contacts actifs du tenant, `deleted_at is null` toujours posé). */
export interface ContactFilters {
  tags?: string[];
  /** 'and' (défaut) = contient tous les tags ; 'or' = en partage au moins un. */
  tagMode?: 'and' | 'or';
  /** Exclut tout contact portant au moins un de ces tags (« ne possède pas »). */
  tagsExclude?: string[];
  optIn?: 'opted_in' | 'opted_out' | 'unknown';
  /** Préfixe E.164 ancré (ex. « +336 »). */
  phonePrefix?: string;
  /** Sous-chaîne de chiffres du numéro (ex. « 42 42 »). */
  phoneContains?: string;
  /** Recherche sur le nom de profil (insensible à la casse). */
  nameSearch?: string;
  /**
   * Joignabilité WhatsApp mémorisée ; une seule valeur, `connu_injoignable` : « écarte ceux qu'on sait
   * injoignables ». Un inconnu n'est pas un injoignable (même règle que `verdictWhatsApp`) : un contact jamais
   * sollicité porte `null`, d'où `is not false` et jamais `is not true`. Pas de canal RCS ici : sa joignabilité
   * vit dans un cache par agent (`src/rcs/reachability.ts`), et l'approcher autrement en ferait une seconde définition.
   */
  joignabiliteWhatsApp?: 'connu_injoignable';
  /**
   * Le niveau de risque de désengagement stocké. Une fiche jamais calculée (`risque_niveau` null) n'est dans aucun
   * niveau, `inconnu` compris. Une valeur hors des quatre niveaux est refusée par `buildContactFilters`.
   */
  risque?: NiveauRisque;
  fieldFilters?: ContactFieldFilter[];
}

/** Cible d'une action en masse : une liste d'ids explicites, ou un jeu de filtres re-résolu côté serveur (avec
 *  exclusions pour les lignes décochées d'un « tout sélectionner »), jamais 100k UUID en payload. */
export type BulkTarget = { ids: string[] } | { filters: ContactFilters; excludeIds?: string[] };

/** Mutation d'une action en masse. Valeur de champ déjà validée et canonicalisée en amont (route). */
export interface BulkEdits {
  addTags?: string[];
  removeTags?: string[];
  setField?: { key: string; value: string };
  /**
   * Bascule du consentement marketing depuis le mini-CRM, en masse. L'upsert d'import ne fait jamais régresser un
   * statut : un refus s'écrit par une méthode dédiée (celle-ci, `applyEdits`, `setOptInByWaId`,
   * `ecrireConsentementParId`), liste dérivée par `tests/optout-poussee.test.ts`.
   */
  setOptIn?: 'opted_in' | 'opted_out';
}

/**
 * Store Postgres des contacts. Upsert par (tenant, téléphone) avec fusion jsonb des champs perso (jamais
 * d'écrasement des clés absentes du CSV) et un opt-in qui ne régresse jamais (unknown -> opted_in seulement).
 */
export class PgContactStore implements ContactStore {
  /**
   * @param annoncerDesabonnement appelée après chaque écriture qui pose `opted_out`, avec les `wa_id` touchés.
   *   🔴 Ici et pas chez les appelants : l'invariant « un refus se pousse vers le système du client » couvre ainsi
   *   par construction toutes les méthodes qui écrivent `opted_out` (liste dérivée par `tests/optout-poussee.test.ts`).
   *   Appelée après le `commit`, et ce qu'elle lève est absorbé : elle ne peut pas faire échouer l'écriture.
   *   Absente : personne n'est prévenu (scripts et tests). `messageDuStop` : l'identifiant du message STOP, qui
   *   rend l'identifiant du signal stable d'une redélivrance à l'autre.
   */
  constructor(
    private readonly pool: Pool,
    private readonly annoncerDesabonnement?: (tenantId: string, waIds: string[], messageDuStop?: string) => Promise<void>,
  ) {}

  /**
   * Annonce sans jamais lever : le refus est déjà enregistré, et une exception ferait rendre 500 à la route qui
   * vient de l'écrire.
   */
  private async annoncer(tenantId: string, waIds: Array<string | null>, messageDuStop?: string): Promise<void> {
    if (!this.annoncerDesabonnement) return;
    const propres = waIds.filter((w): w is string => typeof w === 'string' && w.trim() !== '');
    if (propres.length === 0) return;
    try {
      await this.annoncerDesabonnement(tenantId, propres, messageDuStop);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`contacts: annonce d opt-out impossible pour ${tenantId}:`, messageDe(err));
    }
  }

  /**
   * Upsert d'un contact par son numéro, qui rend son id : webhook entrant et création à la main dans la console.
   * L'API publique passe par `resoudreFiche` et `creerFicheApi`.
   */
  async upsertByPhoneReturningId(c: ContactUpsert): Promise<{ id: string; created: boolean }> {
    // Index unique partiel contacts_tenant_phone_uidx (where phone_e164 is not null) : le ON CONFLICT doit répéter
    // le prédicat pour cibler cet index.
    const res = await this.pool.query<{ id: string; created: boolean }>(
      `insert into contacts (tenant_id, phone_e164, profile_name, fields, opt_in_status, opt_in_source, tags, bsuid)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7::text[], $8)
       on conflict (tenant_id, phone_e164) where phone_e164 is not null
       do update set
         fields = contacts.fields || excluded.fields,
         profile_name = coalesce(excluded.profile_name, contacts.profile_name),
         -- coalesce, et pas une affectation seche : un upsert SANS bsuid (webhook entrant, création à la main dans la console) ne doit pas
         -- effacer l'identifiant d'un contact arrivé par l'inbound sans numéro partagé.
         bsuid = coalesce(excluded.bsuid, contacts.bsuid),
         -- UN STOP NE SE LEVE PAS ICI (2026-09-26). Le webhook entrant (un outil tiers) et la creation a la
         -- main dans la console passent par cet upsert ; avec un opted_in, ils reabonnaient quelqu un qui avait
         -- dit STOP. Sur une fiche opted_out, le statut, la date ET la source restent ceux du refus : la source
         -- dit le canal du STOP au signal (completerSignal). Le nom, les champs et les tags se mettent a jour
         -- quand meme. Seuls la fiche de la console, la personne elle-meme et l import CSV case cochee levent
         -- un STOP. Les trois affectations lisent contacts.* AVANT la mise a jour : leur ordre est indifferent.
         opt_in_status = case
           when excluded.opt_in_status = 'opted_in' and contacts.opt_in_status <> 'opted_out' then 'opted_in'
           else contacts.opt_in_status
         end,
         -- La date de desabonnement suit le statut (migration 0138) : remise a null seulement quand le
         -- statut passe a opted_in.
         opt_out_at = case
           when excluded.opt_in_status = 'opted_in' and contacts.opt_in_status <> 'opted_out' then null
           else contacts.opt_out_at
         end,
         opt_in_source = case
           when contacts.opt_in_status = 'opted_out' then contacts.opt_in_source
           else coalesce(excluded.opt_in_source, contacts.opt_in_source)
         end,
         -- Union dédupliquée : les nouveaux tags s'ajoutent, jamais d'écrasement.
         tags = (select coalesce(array_agg(distinct t), '{}') from unnest(contacts.tags || excluded.tags) t),
         -- Ré-ajouter un contact (webhook entrant, création à la main dans la console) le RESSUSCITE : re-poser le numéro
         -- efface la suppression douce. Sur un contact déjà actif, no-op (deleted_at était déjà null).
         deleted_at = null,
         updated_at = now()
       returning id, (xmax = 0) as created`,
      [
        c.tenantId,
        c.phoneE164,
        c.profileName,
        JSON.stringify(c.fields),
        c.optInStatus,
        c.optInSource ?? null,
        c.tags ?? [],
        c.bsuid ?? null,
      ],
    );
    const row = res.rows[0]!;
    return { id: row.id, created: row.created };
  }

  /**
   * Upsert d'un lot en une requête, avec les règles d'écriture de `upsertByPhoneReturningId` : fusion jsonb des
   * champs, nom conservé faute de nouveau, opt-in qui ne régresse jamais, STOP gardé, union des tags, résurrection
   * d'un contact supprimé. Seule différence : un lot `peutLeverStop` (import CSV case cochée) lève un STOP.
   * Le lot voyage en un seul paramètre JSON (`jsonb_to_recordset`) : un tableau de fragments JSON devrait être
   * échappé comme littéral de tableau Postgres, piège à la moindre accolade ou virgule.
   * Déduplication obligatoire : Postgres refuse qu'un `on conflict do update` touche deux fois la même ligne dans
   * une commande. Les occurrences d'un même numéro fusionnent avant l'écriture (la suivante écrase les mêmes clés,
   * un nom non vide gagne).
   */
  async upsertManyByPhone(lot: LotContacts): Promise<Array<'created' | 'updated'>> {
    if (lot.contacts.length === 0) return [];

    const fusion = new Map<string, ContactDeLot>();
    const premiereApparition = new Map<string, number>();
    lot.contacts.forEach((c, i) => {
      const deja = fusion.get(c.phoneE164);
      if (!deja) {
        fusion.set(c.phoneE164, { ...c, fields: { ...c.fields } });
        premiereApparition.set(c.phoneE164, i);
        return;
      }
      Object.assign(deja.fields, c.fields);
      if (c.profileName !== null) deja.profileName = c.profileName;
    });

    const lignes = [...fusion.values()].map((c) => ({
      phone: c.phoneE164,
      nom: c.profileName,
      champs: c.fields,
    }));

    const res = await this.pool.query<{ phone_e164: string; created: boolean }>(
      `insert into contacts (tenant_id, phone_e164, profile_name, fields, opt_in_status, opt_in_source, tags)
       -- Chaque paramètre est CASTÉ explicitement : dans un « insert ... select », Postgres ne déduit pas
       -- toujours le type d'un paramètre depuis la colonne visée, et refuse alors la requête entière.
       -- Alias « l » et non « t » : la clause de conflit plus bas utilise déjà « t » pour son unnest.
       select $1::uuid, l.phone, l.nom, coalesce(l.champs, '{}'::jsonb), $2::text, $3::text, $4::text[]
       from jsonb_to_recordset($5::jsonb) as l(phone text, nom text, champs jsonb)
       on conflict (tenant_id, phone_e164) where phone_e164 is not null
       do update set
         fields = contacts.fields || excluded.fields,
         profile_name = coalesce(excluded.profile_name, contacts.profile_name),
         -- UN STOP NE SE LEVE PAS PAR IMPORT, SAUF LA CASE COCHEE D UN CSV ($6, decision de Julien du
         -- 2026-09-26). Une liste HubSpot qui contenait quelqu un qui avait dit STOP le reabonnait. Sans $6,
         -- une fiche opted_out garde le statut, la date ET la source de son refus (la source dit le canal du
         -- STOP au signal, completerSignal) ; le nom, les champs et les tags se mettent a jour quand meme.
         opt_in_status = case
           when excluded.opt_in_status = 'opted_in' and (contacts.opt_in_status <> 'opted_out' or $6::boolean) then 'opted_in'
           else contacts.opt_in_status
         end,
         -- La date de desabonnement suit le statut (migration 0138) : remise a null seulement quand le
         -- statut passe a opted_in, y compris quand la case cochee leve un STOP.
         opt_out_at = case
           when excluded.opt_in_status = 'opted_in' and (contacts.opt_in_status <> 'opted_out' or $6::boolean) then null
           else contacts.opt_out_at
         end,
         opt_in_source = case
           when contacts.opt_in_status = 'opted_out' and not $6::boolean then contacts.opt_in_source
           else coalesce(excluded.opt_in_source, contacts.opt_in_source)
         end,
         tags = (select coalesce(array_agg(distinct t), '{}') from unnest(contacts.tags || excluded.tags) t),
         deleted_at = null,
         updated_at = now()
       returning phone_e164, (xmax = 0) as created`,
      // `bsuid` n'est pas écrit : un import n'en porte jamais, et ne pas toucher la colonne préserve l'identifiant d'un
      // contact arrivé sans numéro partagé. $6 : `=== true`, jamais une coercition ; absent vaut non, et garde le STOP.
      [lot.tenantId, lot.optInStatus, lot.optInSource ?? null, lot.tags ?? [], JSON.stringify(lignes), lot.peutLeverStop === true],
    );

    const creePar = new Map(res.rows.map((r) => [r.phone_e164, r.created] as const));
    // Un numéro en double n'est « créé » qu'à sa première apparition, les suivantes sont des mises à jour : sinon
    // un fichier qui répète cinq fois un contact annoncerait cinq créations.
    return lot.contacts.map((c, i) =>
      creePar.get(c.phoneE164) === true && premiereApparition.get(c.phoneE164) === i ? 'created' : 'updated',
    );
  }

  /** Contact actif par téléphone E.164 exact (tenant scopé), ou null s'il est absent ou supprimé : un contact
   *  supprimé est introuvable pour le serveur MCP (`contactParTelephone`). Jamais destinataire d'un envoi. */
  async findByPhone(tenantId: string, phoneE164: string): Promise<ContactRow | null> {
    const res = await this.pool.query(
      `select id, phone_e164, bsuid, external_id, profile_name, opt_in_status, fields, tags, created_at, blocked_at,
              whatsapp_joignable, whatsapp_joignable_le, ${PgContactStore.COLONNES_RISQUE}
       from contacts where tenant_id = $1 and phone_e164 = $2 and deleted_at is null limit 1`,
      [tenantId, phoneE164],
    );
    const r = res.rows[0];
    return r ? PgContactStore.rowToContact(r) : null;
  }

  /**
   * Fusion jsonb des valeurs saisies dans un WhatsApp Flow sur le contact du `wa_id` (`MATCH_BY_WAID_SQL`) : les
   * clés fournies écrasent, les autres restent. Ne crée pas de fiche pour un numéro hors base. Rend le nombre de
   * contacts touchés (0 = inconnu).
   */
  async mergeFieldsByPhone(tenantId: string, waId: string, values: Record<string, unknown>): Promise<number> {
    if (Object.keys(values).length === 0) return 0;
    const res = await this.pool.query(
      `update contacts set fields = fields || $3::jsonb, updated_at = now()
       where id = (
         select id from contacts where tenant_id = $1
         ${MATCH_BY_WAID_SQL}
       )`,
      [tenantId, waId, JSON.stringify(values)],
    );
    return res.rowCount ?? 0;
  }

  /**
   * Consentement marketing explicite capté par un WhatsApp Flow (OptIn coché) : passe le contact en `opted_in`,
   * même sur un `opted_out` antérieur (une action fraîche du contact dans WhatsApp est une preuve forte). Ne crée
   * pas de fiche. Rend l'identifiant du contact touché, ou `null` : seul l'identifiant peut aller au journal
   * d'audit, le numéro ruinerait la purge.
   */
  async markOptedIn(tenantId: string, waId: string, source: string): Promise<string | null> {
    return this.setOptInByWaId(tenantId, waId, 'opted_in', source);
  }

  /**
   * Écrit le consentement d'un contact désigné par son `wa_id`, dans les deux sens : bloc « Action » d'un scénario,
   * mot-clé STOP, et consentement d'un Flow (`markOptedIn`). Une seule écriture et une seule copie de
   * `MATCH_BY_WAID_SQL`. Rend l'identifiant du contact touché, `null` s'il est inconnu ; ne crée aucune fiche.
   * `messageDuStop` : l'identifiant du message STOP, pour que le signal reste stable si Meta le redélivre.
   *
   * 🔴 Rien n'est écrit ni annoncé quand le statut ne change pas : le premier geste garde sa source et sa date
   * (la source, relue pour pousser le signal, dit le canal du STOP), et un seul STOP ne s'annonce qu'une fois.
   */
  async setOptInByWaId(
    tenantId: string,
    waId: string,
    statut: 'opted_in' | 'opted_out',
    source: string,
    messageDuStop?: string,
  ): Promise<string | null> {
    const res = await this.pool.query<{ id: string; avant: string | null }>(
      // 🔴 `opt_out_at` suit le statut dans les deux sens : posée au désabonnement, remise à null au réabonnement.
      // L'ancien statut est lu dans la même instruction, sous verrou (`for update`) : deux STOP simultanés liraient
      // sinon tous deux « abonné » et annonceraient deux fois. L'écriture est gardée par `is distinct from` : un statut
      // déjà en place n'est pas réécrit. La fiche est rendue par `avant`, écrite ou non.
      `with avant as (
         select id, opt_in_status from contacts where tenant_id = $1
         ${MATCH_BY_WAID_SQL}
         for update
       ),
       ecrit as (
         update contacts set opt_in_status = $4, opt_in_source = $3, updated_at = now(),
                opt_out_at = case when $4 = 'opted_out' then now() else null end
         where id = (select id from avant) and opt_in_status is distinct from $4
         returning id
       )
       select id, opt_in_status as avant from avant`,
      [tenantId, waId, source, statut],
    );
    const id = res.rows[0]?.id ?? null;
    // L'annonce vient après l'écriture, et seulement si elle a touché quelqu'un et changé son statut : ni personne
    // inconnue poussée chez le client, ni deux événements pour un seul STOP.
    if (statut === 'opted_out' && id !== null && res.rows[0]?.avant !== 'opted_out') await this.annoncer(tenantId, [waId], messageDuStop);
    return id;
  }

  /**
   * Le consentement posé par l'API publique sur une fiche désignée par son identifiant (`appliquerConsentement`).
   * N'écrit que si le statut change (`is distinct from`) : un outil qui renvoie le même consentement ne repousse
   * pas la date d'un désabonnement et n'annonce pas dix fois le même refus. `opt_out_at` suit le statut. La
   * seconde requête, qui distingue `inchange` d'`absente`, ne part que si la première n'a rien touché.
   */
  async ecrireConsentementParId(
    tenantId: string,
    contactId: string,
    statut: 'opted_in' | 'opted_out',
    source: string,
  ): Promise<'change' | 'inchange' | 'refuse' | 'absente'> {
    // 🔴 Un STOP ne se lève pas par machine : cette écriture ne fait jamais passer `opted_out` à `opted_in` (une
    // synchronisation périmée réabonnerait quelqu'un qui a dit stop). La garde est dans la requête, pour tenir un
    // STOP arrivé entre la vérification et l'écriture. Seul un opérateur (`applyEdits`) ou la personne le lève.
    const res = await this.pool.query<{ phone_e164: string | null; bsuid: string | null }>(
      `update contacts set opt_in_status = $3, opt_in_source = $4, updated_at = now(),
              opt_out_at = case when $3 = 'opted_out' then now() else null end
        where tenant_id = $1 and id = $2 and deleted_at is null and opt_in_status is distinct from $3
          and not ($3 = 'opted_in' and opt_in_status = 'opted_out')
        returning phone_e164, bsuid`,
      [tenantId, contactId, statut, source],
    );
    const r = res.rows[0];
    if (r) {
      // Après l'écriture, jamais avant : ce qui part vers le système du client décrit ce qui est enregistré.
      if (statut === 'opted_out') await this.annoncer(tenantId, [waIdOf(r.phone_e164, r.bsuid)]);
      return 'change';
    }
    // La relecture dit pourquoi rien n'a bougé : fiche partie, STOP à respecter, ou statut déjà en place.
    const existe = await this.pool.query<{ opt_in_status: string }>(
      'select opt_in_status from contacts where tenant_id = $1 and id = $2 and deleted_at is null',
      [tenantId, contactId],
    );
    const ligne = existe.rows[0];
    if (!ligne) return 'absente';
    return statut === 'opted_in' && ligne.opt_in_status === 'opted_out' ? 'refuse' : 'inchange';
  }

  /**
   * Écrit le nom (profile_name) du contact d'un numéro, pour le champ de base « Nom » d'un WhatsApp Flow (un
   * attribut, pas une clé de `contacts.fields`). Ne crée pas de fiche ; nom vide -> rien. Rend le nombre touché.
   */
  async setProfileNameByPhone(tenantId: string, waId: string, name: string): Promise<number> {
    const n = name.trim();
    if (n === '') return 0;
    const res = await this.pool.query(
      `update contacts set profile_name = $3, updated_at = now()
       where id = (
         select id from contacts where tenant_id = $1
         ${MATCH_BY_WAID_SQL}
       )`,
      [tenantId, waId, n],
    );
    return res.rowCount ?? 0;
  }

  /**
   * Ajoute des tags au contact d'un numéro et dit lesquels étaient réellement nouveaux : « tag ajouté » déclenche
   * un scénario, donc un envoi facturé, et le `rowCount` vaut 1 même quand rien ne change. `RETURNING` l'état
   * d'avant (par une sous-requête) donne le delta sans aller-retour de plus.
   */
  async addTagsByPhoneReturningNew(tenantId: string, waId: string, tags: string[]): Promise<{ touched: number; added: string[] }> {
    const clean = [...new Set(tags.map((t) => t.trim()).filter((t) => t !== ''))];
    if (clean.length === 0) return { touched: 0, added: [] };
    const res = await this.pool.query<{ avant: string[] | null }>(
      `update contacts c set tags = (select coalesce(array_agg(distinct t), '{}') from unnest(c.tags || $3::text[]) t), updated_at = now()
       from (
         select id, tags from contacts where tenant_id = $1
         ${MATCH_BY_WAID_SQL}
       ) src
       where c.id = src.id
       returning src.tags as avant`,
      [tenantId, waId, clean],
    );
    const avant = new Set(res.rows[0]?.avant ?? []);
    return { touched: res.rowCount ?? 0, added: (res.rowCount ?? 0) === 0 ? [] : clean.filter((t) => !avant.has(t)) };
  }

  /** Retire des tags du contact d'un numéro (bloc Action « retirer un tag »), sans créer de fiche. Rend le nb touché. */
  async removeTagsByPhone(tenantId: string, waId: string, tags: string[]): Promise<number> {
    const clean = [...new Set(tags.map((t) => t.trim()).filter((t) => t !== ''))];
    if (clean.length === 0) return 0;
    const res = await this.pool.query(
      `update contacts set tags = (select coalesce(array_agg(t), '{}') from unnest(tags) t where t <> all($3::text[])), updated_at = now()
       where id = (
         select id from contacts where tenant_id = $1
         ${MATCH_BY_WAID_SQL}
       )`,
      [tenantId, waId, clean],
    );
    return res.rowCount ?? 0;
  }

  /** Vide des champs (clés de `contacts.fields`) du contact d'un numéro (bloc Action « vider un champ »), sans
   *  créer de fiche. Rend le nb de contacts touchés. */
  async clearFieldsByPhone(tenantId: string, waId: string, keys: string[]): Promise<number> {
    const clean = [...new Set(keys.map((k) => k.trim()).filter((k) => k !== ''))];
    if (clean.length === 0) return 0;
    const res = await this.pool.query(
      `update contacts set fields = fields - $3::text[], updated_at = now()
       where id = (
         select id from contacts where tenant_id = $1
         ${MATCH_BY_WAID_SQL}
       )`,
      [tenantId, waId, clean],
    );
    return res.rowCount ?? 0;
  }

  /**
   * Crée ou rafraîchit une fiche depuis un message entrant, le `wa_id` classé en numéro ou BSUID (`classifyWaId`).
   * Ne fait jamais régresser l'opt-in (`unknown` seulement à la création, source 'inbound') et ne met à jour que le
   * nom de profil (jamais écrasé par null). Best-effort, à appeler isolé : ne doit pas casser l'inbox.
   */
  async upsertFromInbound(tenantId: string, waId: string, profileName: string | null): Promise<'created' | 'updated' | 'skipped'> {
    const { phoneE164, bsuid } = classifyWaId(waId);
    if (!phoneE164 && !bsuid) return 'skipped';
    // Deux index uniques partiels distincts (phone / bsuid) -> le ON CONFLICT doit cibler le bon.
    const conflict = phoneE164
      ? 'on conflict (tenant_id, phone_e164) where phone_e164 is not null'
      : 'on conflict (tenant_id, bsuid) where bsuid is not null';
    const res = await this.pool.query<{ created: boolean }>(
      `insert into contacts (tenant_id, phone_e164, bsuid, profile_name, opt_in_status, opt_in_source)
       values ($1, $2, $3, $4, 'unknown', 'inbound')
       ${conflict}
       do update set profile_name = coalesce(excluded.profile_name, contacts.profile_name), updated_at = now()
       returning (xmax = 0) as created`,
      [tenantId, phoneE164 ?? null, bsuid ?? null, profileName],
    );
    return res.rows[0]?.created ? 'created' : 'updated';
  }

  /**
   * Résout un contact par wa_id pour remplir les variables d'un template envoyé par un scénario
   * (`MATCH_BY_WAID_SQL`). null si hors base : l'appelant retombe sur les exemples du template. `bsuid` inclus pour
   * que les sources `bsuid` et `wa_id` se résolvent aussi sur cette voie.
   */
  async getResolvableByPhone(
    tenantId: string,
    waId: string,
  ): Promise<{ phone_e164: string | null; bsuid: string | null; profile_name: string | null; fields: Record<string, unknown> } | null> {
    const res = await this.pool.query<{ phone_e164: string | null; bsuid: string | null; profile_name: string | null; fields: Record<string, unknown> | null }>(
      `select phone_e164, bsuid, profile_name, fields from contacts where tenant_id = $1
         ${MATCH_BY_WAID_SQL}`,
      [tenantId, waId],
    );
    const r = res.rows[0];
    return r ? { phone_e164: r.phone_e164, bsuid: r.bsuid, profile_name: r.profile_name, fields: r.fields ?? {} } : null;
  }

  /**
   * La fiche d'un contact projetée pour ce qui sort de chez nous (connecteur, poussée d'un opt-out, relais de
   * l'agent de Meta) ou pour un modèle (`mba_lire_contact`) ; `null` hors base.
   * 🔴 Projection, jamais la ligne brute : numéro, BSUID et statut d'opt-in ne partent pas vers un tiers ; le nom,
   * les tags et les champs suffisent. Relue à chaque appel, pour voir un champ qu'un bloc vient d'écrire.
   */
  async projectionPourTiers(
    tenantId: string,
    waId: string,
  ): Promise<{ nom: string; tags: string[]; champs: Record<string, unknown> } | null> {
    const etat = await this.getContactStateByWaId(tenantId, waId);
    return etat ? { nom: etat.name ?? '', tags: etat.tags, champs: etat.fields } : null;
  }

  /**
   * Les valeurs des champs FIXES de la fiche (`src/crm/champs-fiche.ts`), pour l'origine `fiche` d'une donnée de
   * connecteur ; `null` hors base. Une seule lecture par appel, faite seulement si une donnée la réclame.
   * `wa_id` n'y est pas : il vient du tour, authentifié par la signature du webhook Meta, jamais de la base.
   * Les dates partent en ISO 8601 ; une note ou « résolue » à `null` veut dire « pas de mesure », jamais 0 ni non.
   * Le risque de départ est le NIVEAU (les codes de `NIVEAUX_RISQUE`), comme avant ce lot.
   */
  async ficheDuContact(tenantId: string, waId: string): Promise<Partial<Record<CleFicheFixe, string | number | boolean | null>> | null> {
    const res = await this.pool.query<{
      profile_name: string | null; external_id: string | null; created_at: Date;
      analyse_intention: string | null; analyse_sentiment: string | null; analyse_satisfaction: number | null;
      analyse_urgence: number | null; analyse_resolue: boolean | null; analyse_sujet: string | null;
      analyse_traitee_par: string | null; analyse_action: string | null; analyse_le: Date | null; risque_niveau: string | null;
    }>(
      `select profile_name, external_id, created_at, analyse_intention, analyse_sentiment, analyse_satisfaction,
              analyse_urgence, analyse_resolue, analyse_sujet, analyse_traitee_par, analyse_action, analyse_le, risque_niveau
         from contacts
        where tenant_id = $1 and deleted_at is null
        ${MATCH_BY_WAID_SQL}`,
      [tenantId, waId],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      nom: r.profile_name,
      external_id: r.external_id,
      created_at: r.created_at.toISOString(),
      analyse_intention: r.analyse_intention,
      analyse_sentiment: r.analyse_sentiment,
      analyse_satisfaction: r.analyse_satisfaction,
      analyse_urgence: r.analyse_urgence,
      analyse_resolue: r.analyse_resolue,
      analyse_sujet: r.analyse_sujet,
      analyse_traitee_par: r.analyse_traitee_par,
      analyse_action: r.analyse_action,
      analyse_le: r.analyse_le ? r.analyse_le.toISOString() : null,
      risque_depart: r.risque_niveau,
    };
  }

  /**
   * État d'un contact par wa_id pour évaluer une condition de scénario (bloc « Si ») : champs, tags, opt-in et
   * attributs. `null` si hors base : l'appelant prend la branche 'false'. Forme alignée sur `EvalContext`.
   */
  async getContactStateByWaId(
    tenantId: string,
    waId: string,
  ): Promise<{ fields: Record<string, unknown>; tags: string[]; optIn: string; name: string | null; phone: string | null; bsuid: string | null; analyse: AnalyseDeFiche | null } | null> {
    const res = await this.pool.query<{ phone_e164: string | null; bsuid: string | null; profile_name: string | null; opt_in_status: string; fields: Record<string, unknown> | null; tags: string[] | null } & LigneAnalyseFiche>(
      `select phone_e164, bsuid, profile_name, opt_in_status, fields, tags, ${COLONNES_ANALYSE_FICHE.join(', ')}
         from contacts where tenant_id = $1
         ${MATCH_BY_WAID_SQL}`,
      [tenantId, waId],
    );
    const r = res.rows[0];
    // La dernière analyse voyage À CÔTÉ des champs, jamais dedans : la fonction JS d'un scénario reçoit `fields`.
    return r
      ? { fields: r.fields ?? {}, tags: r.tags ?? [], optIn: r.opt_in_status, name: r.profile_name, phone: r.phone_e164, bsuid: r.bsuid, analyse: analyseDeLaLigne(r) }
      : null;
  }

  /**
   * 🔴 Ce contact a-t-il demandé à ne plus être contacté ? Méthode la plus étroite possible, sur le chemin de
   * chaque envoi automatique (ne pas ramener le jsonb des champs pour lire un mot). Un contact inconnu n'est pas
   * désabonné : c'est le cas ordinaire d'un premier contact.
   */
  async estDesabonneParWaId(tenantId: string, waId: string): Promise<boolean> {
    const res = await this.pool.query<{ opt_in_status: string }>(
      `select opt_in_status from contacts where tenant_id = $1 ${MATCH_BY_WAID_SQL}`,
      [tenantId, waId],
    );
    return res.rows[0]?.opt_in_status === 'opted_out';
  }

  /**
   * Ce contact a-t-il consenti, ou nous a-t-il déjà écrit ? La garde d'un RCS libre envoyé par une machine : un
   * message simple ne fonde pas une relation. « A écrit » = au moins un entrant dans son fil, tout canal. Un
   * contact inconnu rend `false`. Le `exists` s'arrête au premier entrant, par l'index (conversation_id, created_at).
   */
  async aConsentiOuEcritParWaId(tenantId: string, waId: string): Promise<boolean> {
    const res = await this.pool.query<{ ok: boolean }>(
      `select (opt_in_status = 'opted_in')
              or exists (
                select 1
                  from conversations v
                  join conversation_messages m on m.conversation_id = v.id
                 where v.tenant_id = $1 and v.wa_id = $2 and m.direction = 'in'
              ) as ok
         from contacts
        where tenant_id = $1 and deleted_at is null
        ${MATCH_BY_WAID_SQL}`,
      [tenantId, waId],
    );
    return res.rows[0]?.ok === true;
  }

  /** Ce qu'un envoi simple doit savoir d'une fiche : son numéro, et si elle est bloquée. `null` = introuvable
   *  dans cet espace, ou supprimée. Sert `POST /v1/messages/rcs`. */
  async etatPourEnvoi(tenantId: string, contactId: string): Promise<{ phoneE164: string | null; bloque: boolean } | null> {
    const res = await this.pool.query<{ phone_e164: string | null; bloque: boolean }>(
      `select phone_e164, (blocked_at is not null) as bloque
         from contacts
        where tenant_id = $1 and id = $2::uuid and deleted_at is null`,
      [tenantId, contactId],
    );
    const r = res.rows[0];
    return r ? { phoneE164: r.phone_e164, bloque: r.bloque } : null;
  }

  /**
   * Bloque ou débloque un contact (modération) : plus aucun envoi vers lui, et sa conversation disparaît de
   * l'inbox. Ses messages restent enregistrés : filtrer à la réception ferait disparaître une résiliation ou une
   * menace juridique. `false` = contact inconnu pour ce tenant (404 chez l'appelant).
   */
  async setBlocked(tenantId: string, contactId: string, bloque: boolean, parUserId: string | null): Promise<boolean> {
    const res = await this.pool.query(
      `update contacts
          set blocked_at = case when $3 then now() else null end,
              blocked_by = case when $3 then $4::uuid else null end
        where id = $1 and tenant_id = $2 and deleted_at is null`,
      [contactId, tenantId, bloque, parUserId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Ce contact est-il bloqué ? Interrogé par `wa_id`, comme raisonnent les automations et l'inbox. Contact inconnu
   * -> `false` : on ne bloque que ce qui a été explicitement bloqué.
   */
  async isBlockedByWaId(tenantId: string, waId: string): Promise<boolean> {
    const res = await this.pool.query<{ bloque: boolean }>(
      `select (blocked_at is not null) as bloque from contacts
        where tenant_id = $1 and deleted_at is null
          ${MATCH_BY_WAID_SQL}`,
      [tenantId, waId],
    );
    return res.rows[0]?.bloque === true;
  }

  /** Contacts bloqués du tenant, du plus récemment bloqué au plus ancien (écran des paramètres). */
  async listBlocked(tenantId: string): Promise<Array<{ id: string; profileName: string | null; phoneE164: string | null; blockedAt: string }>> {
    const res = await this.pool.query<{ id: string; profile_name: string | null; phone_e164: string | null; blocked_at: Date }>(
      `select id, profile_name, phone_e164, blocked_at from contacts
        where tenant_id = $1 and deleted_at is null and blocked_at is not null
        order by blocked_at desc`,
      [tenantId],
    );
    return res.rows.map((r) => ({
      id: r.id, profileName: r.profile_name, phoneE164: r.phone_e164, blockedAt: r.blocked_at.toISOString(),
    }));
  }

  /**
   * Les contacts qui ont demandé à ne plus être contactés, du plus récent au plus ancien. `desabonneLe` peut être
   * `null` (refus antérieurs à la colonne) et l'écran le dit : la reconstituer depuis `updated_at` serait faux.
   * `source` dit d'où vient le refus ('crm', 'scenario', 'flow', 'webhook:<nom>'), seul moyen de distinguer un refus
   * de la personne d'un statut posé par l'équipe. Servi par l'index partiel `contacts_opted_out_idx`, dont le
   * prédicat reprend exactement le `where` : l'élargir seul retomberait sur un balayage complet, sans erreur.
   */
  async listeDesabonnes(
    tenantId: string,
    limite = 500,
  ): Promise<Array<{ id: string; profileName: string | null; phoneE164: string | null; desabonneLe: string | null; source: string | null }>> {
    const res = await this.pool.query<{
      id: string; profile_name: string | null; phone_e164: string | null; opt_out_at: Date | null; opt_in_source: string | null;
    }>(
      `select id, profile_name, phone_e164, opt_out_at, opt_in_source
         from contacts
        where tenant_id = $1 and opt_in_status = 'opted_out' and deleted_at is null
        order by opt_out_at desc nulls last, updated_at desc
        limit $2`,
      [tenantId, Math.min(Math.max(1, limite), 2000)],
    );
    return res.rows.map((r) => ({
      id: r.id,
      profileName: r.profile_name,
      phoneE164: r.phone_e164,
      desabonneLe: r.opt_out_at ? r.opt_out_at.toISOString() : null,
      source: r.opt_in_source,
    }));
  }

  /**
   * Les messages entrants récents de contacts pas encore désabonnés, pour que la règle élargie les relise. La règle
   * n'est pas appliquée ici : elle vit dans `src/crm/consentement.ts`, et une seconde version en SQL divergerait.
   * Le plafond compte les messages scannés, pas les résultats : l'appelant doit dire quand il mord, sans quoi des
   * refus plus anciens manqueraient à une liste qui paraît complète. Un message sans fiche contact est gardé.
   */
  async messagesARelire(
    tenantId: string,
    jours = 30,
    limite = 2000,
  ): Promise<{
    scannes: number;
    messages: Array<{ messageId: string; conversationId: string; contactId: string | null; waId: string; profileName: string | null; body: string; recuLe: string }>;
  }> {
    const res = await this.pool.query<{
      id: string; conversation_id: string; contact_id: string | null; wa_id: string;
      profile_name: string | null; body: string; created_at: Date;
    }>(
      `select m.id, m.conversation_id, ct.id as contact_id, cv.wa_id, ct.profile_name, m.body, m.created_at
         from conversation_messages m
         join conversations cv on cv.id = m.conversation_id
         left join contacts ct on ct.id = cv.contact_id and ct.tenant_id = cv.tenant_id
        where cv.tenant_id = $1
          and m.direction = 'in'
          and m.body is not null and btrim(m.body) <> ''
          and m.created_at >= now() - make_interval(days => $2::int)
          and (ct.id is null or (ct.opt_in_status <> 'opted_out' and ct.deleted_at is null))
        order by m.created_at desc
        limit $3`,
      [tenantId, Math.min(Math.max(1, jours), 365), Math.min(Math.max(1, limite), 5000)],
    );
    return {
      scannes: res.rows.length,
      messages: res.rows.map((r) => ({
        messageId: r.id,
        conversationId: r.conversation_id,
        contactId: r.contact_id,
        waId: r.wa_id,
        profileName: r.profile_name,
        body: r.body,
        recuLe: r.created_at.toISOString(),
      })),
    };
  }

  /**
   * Id du contact actif d'un wa_id (`MATCH_BY_WAID_SQL`), pour relier à sa fiche un run de scénario déclenché par
   * une automation. null = aucune fiche, rien à relier.
   */
  async findIdByWaId(tenantId: string, waId: string): Promise<string | null> {
    const res = await this.pool.query<{ id: string }>(
      `select id from contacts where tenant_id = $1 and deleted_at is null
         ${MATCH_BY_WAID_SQL}`,
      [tenantId, waId],
    );
    return res.rows[0]?.id ?? null;
  }

  /**
   * `wa_id` d'un contact (numéro en chiffres nus, sinon BSUID), réciproque de `findIdByWaId`, quand un événement
   * part d'une fiche. null = contact absent, ou sans identité joignable.
   */
  async waIdOfContact(tenantId: string, contactId: string): Promise<string | null> {
    const res = await this.pool.query<{ phone_e164: string | null; bsuid: string | null }>(
      `select phone_e164, bsuid from contacts where id = $1 and tenant_id = $2 and deleted_at is null`,
      [contactId, tenantId],
    );
    const r = res.rows[0];
    if (!r) return null;
    // Règle de routage WhatsApp = `waIdOf` (crm/identity), la définition de référence : une copie divergerait.
    return waIdOf(r.phone_e164, r.bsuid);
  }

  /**
   * Les fiches actives que désigne chacune des clés données, en une requête (API publique, `resoudreFiche`).
   * Chaque clé est unique par espace, donc au plus quatre lignes ; c'est `resoudreFiche` qui juge si elles
   * désignent la même personne. `contactId` doit avoir la forme d'un UUID (sinon `22P02`) ; le numéro est en E.164.
   */
  async chercherParCles(tenantId: string, cles: ClesNormalisees): Promise<FicheIdentite[]> {
    if (!cles.contactId && !cles.externalId && !cles.phoneE164 && !cles.bsuid) return [];
    const res = await this.pool.query<{ id: string; external_id: string | null; phone_e164: string | null; bsuid: string | null }>(
      `select id, external_id, phone_e164, bsuid from contacts
        where tenant_id = $1 and deleted_at is null
          and (id = $2::uuid or external_id = $3 or phone_e164 = $4 or bsuid = $5)
        limit 4`,
      // `|| null` et pas `?? null` : une chaîne vide vaut absence, sinon un `contactId` vide lèverait `22P02` et une
      // clé vide chercherait `''`.
      [tenantId, cles.contactId || null, cles.externalId || null, cles.phoneE164 || null, cles.bsuid || null],
    );
    return res.rows.map((r) => ({ id: r.id, externalId: r.external_id, phoneE164: r.phone_e164, bsuid: r.bsuid }));
  }

  /**
   * Crée une fiche nue pour l'API publique, par son numéro ou à défaut son BSUID. `on conflict ... do update` et
   * non `do nothing` : une fiche supprimée qui porte encore ce numéro est ressuscitée, ses clés gardées
   * (`coalesce`). Mais seulement si les clés demandées tiennent : le `where` du `do update` refuse une fiche qui
   * porte un autre identifiant externe ou BSUID, et c'est « conflit », sans rien avoir écrit. Une violation d'un
   * autre index unique rend « conflit » aussi ; `resoudreFiche` relit alors la base.
   */
  async creerFicheApi(tenantId: string, cles: { phoneE164?: string; bsuid?: string; externalId?: string }): Promise<CreationFiche> {
    if (!cles.phoneE164 && !cles.bsuid) throw new Error('creerFicheApi : un numéro ou un BSUID est requis');
    const conflit = cles.phoneE164
      ? 'on conflict (tenant_id, phone_e164) where phone_e164 is not null'
      : 'on conflict (tenant_id, bsuid) where bsuid is not null';
    try {
      const res = await this.pool.query<{ id: string; created: boolean; external_id: string | null; phone_e164: string | null; bsuid: string | null }>(
        `insert into contacts (tenant_id, phone_e164, bsuid, external_id)
         values ($1, $2, $3, $4)
         ${conflit}
         do update set
           external_id = coalesce(contacts.external_id, excluded.external_id),
           bsuid = coalesce(contacts.bsuid, excluded.bsuid),
           deleted_at = null,
           updated_at = now()
         where (contacts.external_id is null or excluded.external_id is null or contacts.external_id = excluded.external_id)
           and (contacts.bsuid is null or excluded.bsuid is null or contacts.bsuid = excluded.bsuid)
         returning id, (xmax = 0) as created, external_id, phone_e164, bsuid`,
        // `|| null` : une chaîne vide vaut absence ; sinon `{ phoneE164: '' }` insérerait un numéro vide qui occuperait
        // ensuite l'index du numéro.
        [tenantId, cles.phoneE164 || null, cles.bsuid || null, cles.externalId || null],
      );
      const r = res.rows[0];
      // Aucune ligne : la fiche de ce numéro (ou BSUID) porte une autre clé, le `where` a tout refusé.
      if (!r) return 'conflit';
      return { id: r.id, created: r.created, externalId: r.external_id, phoneE164: r.phone_e164, bsuid: r.bsuid };
    } catch (err) {
      if (estUnicite(err)) return 'conflit';
      throw err;
    }
  }

  /**
   * Rattache à une fiche les clés qu'elle ne porte pas encore, sans jamais remplacer une clé portée. Tout ou rien,
   * tenu par le `where` : si une seule clé est portée autrement (y compris par une écriture concurrente), rien
   * n'est touché et c'est « conflit ». Aucune ligne rendue : on relit pour distinguer une fiche absente du conflit.
   * Rattacher un numéro à une fiche qui n'avait qu'un BSUID change son adresse WhatsApp (`waIdOf` préfère le numéro).
   */
  async rattacherCles(
    tenantId: string,
    contactId: string,
    cles: { externalId?: string; phoneE164?: string; bsuid?: string },
  ): Promise<'ok' | 'conflit' | 'absente'> {
    // Une chaîne vide vaut absence : sinon `coalesce` poserait `''`, qui bloquerait ensuite cette valeur pour toute
    // autre fiche de l'espace.
    const voulu = {
      externalId: cles.externalId || undefined,
      phoneE164: cles.phoneE164 || undefined,
      bsuid: cles.bsuid || undefined,
    };
    try {
      const res = await this.pool.query<{ external_id: string | null; phone_e164: string | null; bsuid: string | null }>(
        `update contacts
            set external_id = coalesce(external_id, $3),
                phone_e164 = coalesce(phone_e164, $4),
                bsuid = coalesce(bsuid, $5),
                updated_at = now()
          where tenant_id = $1 and id = $2 and deleted_at is null
            and ($3::text is null or external_id is null or external_id = $3)
            and ($4::text is null or phone_e164 is null or phone_e164 = $4)
            and ($5::text is null or bsuid is null or bsuid = $5)
          returning external_id, phone_e164, bsuid`,
        [tenantId, contactId, voulu.externalId ?? null, voulu.phoneE164 ?? null, voulu.bsuid ?? null],
      );
      const r = res.rows[0];
      if (!r) {
        const existe = await this.pool.query(
          'select 1 from contacts where tenant_id = $1 and id = $2 and deleted_at is null',
          [tenantId, contactId],
        );
        return (existe.rowCount ?? 0) > 0 ? 'conflit' : 'absente';
      }
      const tient = (v: string | undefined, porte: string | null): boolean => v === undefined || v === porte;
      return tient(voulu.externalId, r.external_id) && tient(voulu.phoneE164, r.phone_e164) && tient(voulu.bsuid, r.bsuid) ? 'ok' : 'conflit';
    } catch (err) {
      if (estUnicite(err)) return 'conflit';
      throw err;
    }
  }

  /** Pose ou remplace l'identifiant externe (`PATCH /v1/contacts/{contactId}`). Porté ailleurs : « conflit ». */
  async poserExternalId(tenantId: string, contactId: string, externalId: string): Promise<'ok' | 'conflit' | 'absente'> {
    try {
      const res = await this.pool.query(
        `update contacts set external_id = $3, updated_at = now()
          where tenant_id = $1 and id = $2 and deleted_at is null`,
        [tenantId, contactId, externalId],
      );
      return (res.rowCount ?? 0) > 0 ? 'ok' : 'absente';
    } catch (err) {
      if (estUnicite(err)) return 'conflit';
      throw err;
    }
  }

  /**
   * Écrit ce que l'API publique demande sur une fiche déjà résolue, en une requête : fusion des champs, retrait
   * des clés vidées, union puis retrait des étiquettes, nom (même ordre que `applyEdits`).
   * 🔴 `deleted_at is null` dans le `where` : une purge passée entre `resoudreFiche` et l'écriture ne doit pas
   * réécrire une fiche anonymisée (rend `false`, donc `unknown_contact`). Une seule requête sans transaction :
   * `/v1/contacts/batch` en lance plusieurs à la fois sur un pool partagé avec l'Inbox. N'émet aucun événement
   * d'automation (aucun chemin de masse n'émet).
   */
  async editerFicheApi(tenantId: string, contactId: string, e: EditionFicheApi): Promise<boolean> {
    const res = await this.pool.query(
      `update contacts
          set fields = (coalesce(fields, '{}'::jsonb) || $3::jsonb) - $4::text[],
              -- Sans etiquette a ajouter ni a retirer, la liste n est pas reecrite (ni triee, ni dedoublonnee),
              -- comme applyEdits qui n y touche pas dans ce cas.
              tags = case when cardinality($5::text[]) + cardinality($6::text[]) = 0 then tags
                          else (select coalesce(array_agg(distinct t), '{}')
                                  from unnest(coalesce(tags, '{}') || $5::text[]) t
                                 where t <> all($6::text[]))
                     end,
              profile_name = case when $7::boolean then $8::text else profile_name end,
              updated_at = now()
        where tenant_id = $1 and id = $2 and deleted_at is null`,
      [
        tenantId, contactId, JSON.stringify(e.fields), e.removeFields, e.addTags, e.removeTags,
        e.profileName !== undefined, e.profileName ?? null,
      ],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Parmi `noms`, les étiquettes que l'espace ne connaît pas (ni déclarées, ni portées), selon la définition de
   * `PgTagStore.listDistinct` : l'API refuse ce que la console ne montre pas. `tags @> array[n]` est servi par
   * `contacts_tags_gin`.
   */
  async etiquettesInconnues(tenantId: string, noms: string[]): Promise<string[]> {
    if (noms.length === 0) return [];
    const res = await this.pool.query<{ nom: string }>(
      `select n as nom from unnest($2::text[]) n
        where not exists (select 1 from tags where tenant_id = $1 and name = n)
          and not exists (select 1 from contacts where tenant_id = $1 and tags @> array[n])`,
      [tenantId, noms],
    );
    return res.rows.map((r) => r.nom);
  }

  /** Tout ce que l'API rend d'une fiche, en une requête. Une fiche supprimée n'existe plus : `null`, donc 404.
   *  `contactId` doit avoir la forme d'un UUID (l'appelant le vérifie). */
  async lireFicheApi(tenantId: string, contactId: string): Promise<FicheApiLigne | null> {
    const res = await this.pool.query<{
      id: string; external_id: string | null; phone_e164: string | null; bsuid: string | null; profile_name: string | null;
      fields: Record<string, unknown> | null; tags: string[] | null; opt_in_status: string; opt_in_source: string | null;
      opt_out_at: Date | null; rcs_optout_at: Date | null; blocked_at: Date | null;
      whatsapp_joignable: boolean | null; whatsapp_joignable_le: Date | null; created_at: Date;
      risque_niveau: NiveauRisque | null; risque_score: number | null; risque_raisons: RaisonRisque[] | null; risque_calcule_le: Date | null;
    } & LigneAnalyseFiche>(
      // Colonnes du risque et de l'analyse nommées : leurs migrations passent avant ce code, sinon 42703.
      `select id, external_id, phone_e164, bsuid, profile_name, fields, tags, opt_in_status, opt_in_source,
              opt_out_at, rcs_optout_at, blocked_at, whatsapp_joignable, whatsapp_joignable_le, created_at,
              risque_niveau, risque_score, risque_raisons, risque_calcule_le, ${COLONNES_ANALYSE_FICHE.join(', ')}
         from contacts
        where tenant_id = $1 and id = $2 and deleted_at is null`,
      [tenantId, contactId],
    );
    const r = res.rows[0];
    if (!r) return null;
    const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
    return {
      id: r.id, externalId: r.external_id, phoneE164: r.phone_e164, bsuid: r.bsuid, profileName: r.profile_name,
      fields: r.fields ?? {}, tags: r.tags ?? [], optInStatus: r.opt_in_status, optInSource: r.opt_in_source,
      optOutAt: iso(r.opt_out_at), rcsOptoutAt: iso(r.rcs_optout_at), blockedAt: iso(r.blocked_at),
      whatsappJoignable: r.whatsapp_joignable, whatsappJoignableLe: iso(r.whatsapp_joignable_le),
      risqueNiveau: r.risque_niveau ?? null, risqueScore: r.risque_score ?? null, risqueRaisons: r.risque_raisons ?? [],
      risqueCalculeLe: iso(r.risque_calcule_le ?? null),
      analyse: analyseDeLaLigne(r),
      createdAt: r.created_at.toISOString(),
    };
  }

  /**
   * La dernière analyse et son résumé pour une PAGE de fiches, en UNE requête (le MCP liste jusqu'à 100 contacts :
   * une lecture par fiche ferait cent allers-retours). Une fiche absente de la carte est inconnue de l'espace.
   */
  async analysesEtResumes(tenantId: string, contactIds: readonly string[]): Promise<Map<string, AnalyseEtResume>> {
    const ids = [...new Set(contactIds)];
    if (ids.length === 0) return new Map();
    const res = await this.pool.query<{ id: string; resume: string | null } & LigneAnalyseFiche>(
      `select c.id, ${SELECT_ANALYSE_ET_RESUME}
         from contacts c ${JOINTURE_RESUME}
        where c.tenant_id = $1 and c.id = any($2::uuid[]) and c.deleted_at is null`,
      [tenantId, ids],
    );
    return new Map(res.rows.map((r) => [r.id, { analyse: analyseDeLaLigne(r), resume: r.resume }]));
  }

  /**
   * La même lecture pour UN contact désigné par son `wa_id` (l'outil « Lire la fiche » de l'agent IA, qui ne
   * connaît que le fil du tour). `null` = contact inconnu de l'espace. Résolution par le fragment partagé.
   */
  async analyseEtResumeParWaId(tenantId: string, waId: string): Promise<AnalyseEtResume | null> {
    const res = await this.pool.query<{ resume: string | null } & LigneAnalyseFiche>(
      `select ${SELECT_ANALYSE_ET_RESUME}
         from contacts c ${JOINTURE_RESUME}
        where c.tenant_id = $1 and c.deleted_at is null and ${matchWaIdPredicat('c.', '$2')}
        order by (c.phone_e164 = '+' || $2) desc limit 1`,
      [tenantId, waId],
    );
    const r = res.rows[0];
    return r ? { analyse: analyseDeLaLigne(r), resume: r.resume } : null;
  }

  /**
   * Les colonnes du risque, nommées par les trois `select` qui alimentent `rowToContact` : un `select` qui les
   * oublierait rendrait « pas encore calculé » sur une fiche calculée, sans erreur. Leur migration passe avant ce code.
   */
  private static readonly COLONNES_RISQUE = 'risque_niveau, risque_score, risque_raisons, risque_calcule_le';

  /** Le risque d'une ligne ; un niveau sans date de calcul rend `null` plutôt qu'une date inventée. */
  private static risqueDeLaLigne(r: {
    risque_niveau?: NiveauRisque | null; risque_score?: number | null; risque_raisons?: RaisonRisque[] | null; risque_calcule_le?: Date | null;
  }): RisqueContact | null {
    if (!r.risque_niveau || !r.risque_calcule_le) return null;
    return {
      niveau: r.risque_niveau,
      score: r.risque_niveau === 'inconnu' ? null : (r.risque_score ?? null),
      raisons: r.risque_raisons ?? [],
      calculeLe: r.risque_calcule_le.toISOString(),
    };
  }

  private static rowToContact(r: {
    id: string; external_id?: string | null; phone_e164: string | null; bsuid: string | null; profile_name: string | null;
    opt_in_status: string; fields: Record<string, unknown>; tags: string[] | null; created_at: Date; blocked_at?: Date | null;
    whatsapp_joignable?: boolean | null; whatsapp_joignable_le?: Date | null;
    risque_niveau?: NiveauRisque | null; risque_score?: number | null; risque_raisons?: RaisonRisque[] | null; risque_calcule_le?: Date | null;
  }): ContactRow {
    return {
      id: r.id,
      // `?? null`, pour la même raison que `whatsappJoignable` juste en dessous.
      externalId: r.external_id ?? null,
      phoneE164: r.phone_e164, bsuid: r.bsuid, profileName: r.profile_name, optInStatus: r.opt_in_status,
      fields: r.fields, tags: r.tags ?? [], createdAt: r.created_at.toISOString(),
      blockedAt: r.blocked_at ? r.blocked_at.toISOString() : null,
      // `?? null`, jamais `undefined` : un `undefined` disparaîtrait du corps JSON, et l'écran lirait une clé absente
      // là où il attend « jamais mesuré ». Garde pour un objet construit sans ces clés (un faux de test).
      whatsappJoignable: r.whatsapp_joignable ?? null,
      whatsappJoignableLe: r.whatsapp_joignable_le ? r.whatsapp_joignable_le.toISOString() : null,
      risque: PgContactStore.risqueDeLaLigne(r),
    };
  }
  private static readonly SELECT_ONE =
    `select id, phone_e164, bsuid, external_id, profile_name, opt_in_status, fields, tags, created_at, blocked_at,
            whatsapp_joignable, whatsapp_joignable_le, ${PgContactStore.COLONNES_RISQUE}
       from contacts where id = $1 and tenant_id = $2 and deleted_at is null`;

  /** Un contact par id, scopé tenant. null si absent, supprimé ou d'un autre tenant. */
  async getById(tenantId: string, contactId: string): Promise<ContactRow | null> {
    const res = await this.pool.query(PgContactStore.SELECT_ONE, [contactId, tenantId]);
    const r = res.rows[0];
    return r ? PgContactStore.rowToContact(r) : null;
  }

  /**
   * Édite un contact (fiche) en une transaction, ligne verrouillée : fusion des champs (seules les clés fournies),
   * ajout et retrait de tags. Rend le contact à jour, ou null s'il n'existe pas dans le tenant ou s'il est
   * supprimé (404).
   */
  async applyEdits(
    tenantId: string,
    contactId: string,
    edits: {
      fields: Record<string, string>; removeFields?: string[]; addTags: string[]; removeTags: string[];
      profileName?: string | null;
      /** Consentement posé à la main depuis la fiche (voir l'écriture plus bas). */
      optInStatus?: 'opted_in' | 'opted_out';
    },
  ): Promise<{ contact: ContactRow; addedTags: string[] } | null> {
    const ecrit = await enTransaction(this.pool, async (client) => {
      // Les tags d'avant, lus sous le verrou : seul moyen de savoir lesquels sont réellement nouveaux, et « tag
      // ajouté » relance un scénario.
      // 🔴 `deleted_at is null` ICI, sous le verrou, et pas seulement dans la relecture : les écritures qui suivent
      // n'ont que `id` et `tenant_id`. Une fiche purgée garde son identifiant (lignes de campagne, journal), et
      // la réécrire y rattacherait de nouveau un nom, des champs, des étiquettes, ou lèverait le refus que la purge
      // garde exprès. Face à une purge concurrente : validée avant, la ligne est invisible ici ; écrite mais pas
      // validée, on attend son verrou puis Postgres réévalue ce `where` ; verrouillée ici d'abord, la purge attend.
      const exists = await client.query<{ tags: string[] | null }>('select tags from contacts where id = $1 and tenant_id = $2 and deleted_at is null for update', [contactId, tenantId]);
      if ((exists.rowCount ?? 0) === 0) return null;
      if (Object.keys(edits.fields).length > 0) {
        // Fusion : n'écrase que les clés fournies.
        await client.query('update contacts set fields = fields || $3::jsonb, updated_at = now() where id = $1 and tenant_id = $2', [contactId, tenantId, JSON.stringify(edits.fields)]);
      }
      if (edits.removeFields && edits.removeFields.length > 0) {
        // Retire les clés jsonb (`- text[]`) : purge la valeur du champ sur ce contact, pas la définition.
        await client.query('update contacts set fields = fields - $3::text[], updated_at = now() where id = $1 and tenant_id = $2', [contactId, tenantId, edits.removeFields]);
      }
      if (edits.profileName !== undefined) {
        // Nom (profile_name) éditable ; null = vider. Le téléphone et le BSUID (clés d'identité/routage) restent hors édition.
        await client.query('update contacts set profile_name = $3, updated_at = now() where id = $1 and tenant_id = $2', [contactId, tenantId, edits.profileName]);
      }
      if (edits.optInStatus !== undefined) {
        // Écriture directe du statut, y compris à la baisse : une décision d'opérateur devant la fiche. La source
        // 'crm' distingue un `opted_out` posé ici d'un statut jamais renseigné. Aucun retour à « inconnu » : ce statut
        // veut dire « rien n'a jamais été enregistré ».
        await client.query(
          // `opt_out_at` suit le statut dans les deux sens, cf. `setOptInByWaId`.
          `update contacts set opt_in_status = $3, opt_in_source = 'crm', updated_at = now(),
                  opt_out_at = case when $3 = 'opted_out' then now() else null end
             where id = $1 and tenant_id = $2`,
          [contactId, tenantId, edits.optInStatus],
        );
      }
      if (edits.addTags.length > 0) {
        await client.query(`update contacts set tags = (select coalesce(array_agg(distinct t), '{}') from unnest(tags || $3::text[]) t), updated_at = now() where id = $1 and tenant_id = $2`, [contactId, tenantId, edits.addTags]);
      }
      if (edits.removeTags.length > 0) {
        await client.query(`update contacts set tags = (select coalesce(array_agg(t), '{}') from unnest(tags) t where t <> all($3::text[])), updated_at = now() where id = $1 and tenant_id = $2`, [contactId, tenantId, edits.removeTags]);
      }
      const res = await client.query(PgContactStore.SELECT_ONE, [contactId, tenantId]);
      return { avant: exists.rows[0]?.tags ?? [], r: res.rows[0] };
    });
    if (ecrit === null || !ecrit.r) return null;
    const avant = new Set(ecrit.avant);
    // Le retrait s'applique après l'ajout : un tag présent dans addTags et removeTags n'est pas sur le contact à la
    // fin. On se fie donc à l'état final écrit, pas au snapshot d'avant.
    const apres = new Set(PgContactStore.rowToContact(ecrit.r).tags);
    const contact = PgContactStore.rowToContact(ecrit.r);
    // Après le `commit`, jamais dans la transaction : on n'annonce que ce qui est enregistré, pas un refus qu'un
    // `rollback` viendrait d'annuler.
    if (edits.optInStatus === 'opted_out') {
      await this.annoncer(tenantId, [waIdOf(contact.phoneE164, contact.bsuid)]);
    }
    return {
      contact,
      addedTags: edits.addTags.filter((t) => !avant.has(t) && apres.has(t)),
    };
  }

  /**
   * Requête filtrée et paginée (« Liste de contacts » de campagne, mini-CRM), scopée tenant, `deleted_at is null`
   * toujours posé.
   */
  async query(tenantId: string, filters: ContactFilters, limit = 100, offset = 0): Promise<ContactRow[]> {
    const capped = Math.min(Math.max(limit, 1), 500);
    const { where, params } = buildContactWhere(tenantId, filters);
    const limitRef = `$${params.length + 1}`;
    const offsetRef = `$${params.length + 2}`;
    const res = await this.pool.query<{
      id: string; phone_e164: string | null; bsuid: string | null; profile_name: string | null;
      opt_in_status: string; fields: Record<string, unknown>; tags: string[] | null; created_at: Date;
    }>(
      `select id, phone_e164, bsuid, external_id, profile_name, opt_in_status, fields, tags, created_at, blocked_at,
              whatsapp_joignable, whatsapp_joignable_le, ${PgContactStore.COLONNES_RISQUE}
       from contacts where ${where}
       order by created_at desc limit ${limitRef} offset ${offsetRef}`,
      [...params, capped, Math.max(offset, 0)],
    );
    return res.rows.map(PgContactStore.rowToContact);
  }

  /**
   * Combien de fiches ont chaque champ rempli, et combien de fiches existent en tout, pour que le sélecteur montre
   * qu'un champ voisin est vide. Une seule passe sur les contacts (`jsonb_each_text`), même population que le reste
   * du CRM ; une valeur vide compte comme absente, comme pour le résolveur de variables à l'envoi.
   */
  async fieldUsage(tenantId: string): Promise<{ total: number; parChamp: Record<string, number> }> {
    const [remplis, total] = await Promise.all([
      this.pool.query<{ cle: string; n: string }>(
        `select e.k as cle, count(*)::text as n
           from contacts c, lateral jsonb_each_text(coalesce(c.fields, '{}'::jsonb)) as e(k, v)
          where c.tenant_id = $1 and c.deleted_at is null and btrim(e.v) <> ''
          group by e.k`,
        [tenantId],
      ),
      this.pool.query<{ n: string }>(
        `select count(*)::text as n from contacts where tenant_id = $1 and deleted_at is null`,
        [tenantId],
      ),
    ]);
    const parChamp: Record<string, number> = {};
    for (const r of remplis.rows) parChamp[r.cle] = Number(r.n);
    return { total: Number(total.rows[0]?.n ?? 0), parChamp };
  }

  /** Nombre de contacts correspondant aux filtres (« N contacts » avant de fixer le débit). */
  async count(tenantId: string, filters: ContactFilters): Promise<number> {
    const { where, params } = buildContactWhere(tenantId, filters);
    const res = await this.pool.query<{ n: string }>(`select count(*)::text as n from contacts where ${where}`, params);
    return Number(res.rows[0]?.n ?? 0);
  }

  /** Ids des contacts correspondant aux filtres (source « Liste de contacts » d'une campagne), scopé tenant,
   *  avec un plafond dur. */
  async idsForFilters(tenantId: string, filters: ContactFilters, cap = 100_000): Promise<string[]> {
    const { where, params } = buildContactWhere(tenantId, filters);
    const capRef = `$${params.length + 1}`;
    const res = await this.pool.query<{ id: string }>(
      `select id from contacts where ${where} order by created_at desc limit ${capRef}`,
      [...params, Math.max(1, cap)],
    );
    return res.rows.map((r) => r.id);
  }

  /** Liste paginée des contacts d'un tenant (les plus récents d'abord), éventuellement filtrée sur un tag. */
  async list(tenantId: string, limit = 100, offset = 0, tag?: string): Promise<ContactRow[]> {
    const t = tag?.trim();
    return this.query(tenantId, t ? { tags: [t] } : {}, limit, offset);
  }

  /**
   * Action en masse du mini-CRM sur la cible (ids ou filtres re-résolus, avec exclusions) : tags, un champ perso,
   * consentement. Une seule requête UPDATE ensembliste, scopée `tenant_id` et `deleted_at is null`. La valeur de
   * champ arrive validée et canonicalisée par la route. Rend le nombre touché ; aucune mutation -> 0.
   */
  async applyEditsMany(tenantId: string, target: BulkTarget, edits: BulkEdits): Promise<number> {
    const addTags = [...new Set((edits.addTags ?? []).map((t) => t.trim()).filter((t) => t !== ''))];
    const removeTags = [...new Set((edits.removeTags ?? []).map((t) => t.trim()).filter((t) => t !== ''))];
    const hasSet = edits.setField !== undefined && edits.setField.key.trim() !== '';
    const optIn = edits.setOptIn === 'opted_in' || edits.setOptIn === 'opted_out' ? edits.setOptIn : undefined;
    if (addTags.length === 0 && removeTags.length === 0 && !hasSet && optIn === undefined) return 0;

    const sel = buildBulkSelector(tenantId, target);
    const params = [...sel.params];
    const add = (v: unknown): string => { params.push(v); return `$${params.length}`; };
    const sets: string[] = [];
    if (addTags.length > 0 || removeTags.length > 0) {
      // Une seule assignation `tags =` (Postgres en refuse deux sur une colonne) : union dédupliquée puis retrait, en
      // un sous-select. Un `remove` vide donne `t <> all('{}')`, vrai partout, donc rien retiré.
      const addRef = add(addTags);
      const remRef = add(removeTags);
      sets.push(`tags = (select coalesce(array_agg(distinct t), '{}') from unnest(tags || ${addRef}::text[]) t where t <> all(${remRef}::text[]))`);
    }
    if (hasSet) {
      // Fusion jsonb : n'écrase que la clé posée.
      sets.push(`fields = fields || ${add(JSON.stringify({ [edits.setField!.key]: edits.setField!.value }))}::jsonb`);
    }
    if (optIn !== undefined) {
      // Écriture directe du statut, y compris à la baisse : une décision d'opérateur, source 'crm'. `opt_out_at` suit
      // le statut ; une action en masse n'en porte qu'un, d'où la date posée sans `case`.
      sets.push(`opt_in_status = ${add(optIn)}`, `opt_in_source = ${add('crm')}`,
        `opt_out_at = ${optIn === 'opted_out' ? 'now()' : 'null'}`);
    }
    sets.push('updated_at = now()');
    /**
     * `returning` seulement pour un opt-out : l'annonce a besoin des identités touchées (une relecture après coup
     * pourrait viser d'autres contacts, la cible étant des filtres), mais un `returning` systématique remonterait
     * une ligne par fiche pour toute action en masse, un coût d'egress invisible.
     */
    const estOptOut = optIn === 'opted_out';
    const res = await this.pool.query<{ id: string; phone_e164: string | null; bsuid: string | null }>(
      `update contacts set ${sets.join(', ')} where ${sel.where}${estOptOut ? ' returning id, phone_e164, bsuid' : ''}`,
      params,
    );
    if (estOptOut && res.rows.length > 0) {
      await this.annoncer(tenantId, res.rows.map((r) => waIdOf(r.phone_e164, r.bsuid)));
    }
    return res.rowCount ?? 0;
  }

  /**
   * Résout une cible de masse (identifiants ou filtres) en liste d'identifiants. `limite` borne la sélection par
   * filtres ; l'appelant passe `plafond + 1` pour distinguer « pile au plafond » de « au-dessus ». La branche par
   * identifiants explicites n'est pas bornée : la tronquer enverrait une campagne à un sous-ensemble silencieux.
   */
  async contactIdsForTarget(tenantId: string, target: BulkTarget, limite?: number): Promise<string[]> {
    if ('ids' in target) {
      if (target.ids.length === 0) return [];
      const res = await this.pool.query<{ id: string }>(
        `select id from contacts where tenant_id = $1 and id = any($2::uuid[])`,
        [tenantId, target.ids],
      );
      return res.rows.map((r) => r.id);
    }
    /**
     * Les exclusions sont dans le `WHERE`, donc avant le `LIMIT` : retirées en mémoire après la troncature, elles
     * feraient sous-envoyer une campagne en silence (les éligibles au-delà de la fenêtre jamais atteints).
     */
    const sel = buildBulkSelector(tenantId, target);
    /**
     * Pas de borne haute sur une limite demandée : le plafond de campagne se relève en configuration, et un
     * `Math.min` écraserait en silence une limite plus grande (sous-envoi que l'écran ne montrerait pas). Les
     * 100 000 ne bornent que l'appel sans limite (la purge), qui refuse de matérialiser la table entière.
     */
    const cap = limite === undefined ? 100_000 : Math.max(1, Math.round(limite));
    const res = await this.pool.query<{ id: string }>(
      `select id from contacts where ${sel.where} order by created_at desc limit $${sel.params.length + 1}`,
      [...sel.params, cap],
    );
    return res.rows.map((r) => r.id);
  }

  /**
   * 🔴 Purge : efface réellement les données d'une personne, en gardant les compteurs. `listeAgent` : les lignes
   * de la liste de l'agent de Meta supprimées ici, à retirer chez Meta après la transaction (la route s'en charge).
   * Effacé : le fil, ses messages, son analyse (texte libre tiré de la conversation), et les traces techniques
   * qui portent le numéro (parcours, déclenchements d'automation, cache RCS). Anonymisé : la fiche et ses lignes
   * de campagne restent, colonnes identifiantes remplacées, pour que les totaux restent justes.
   * L'identifiant de remplacement est aléatoire, pas une empreinte du numéro (réversible en quelques minutes).
   * Transactionnel : une purge à moitié faite laisserait du contenu sans moyen de le retrouver.
   */
  async purgeMany(tenantId: string, ids: readonly string[]): Promise<{
    purges: number; conversations: number; messages: number; analyses: number; listeAgent: LigneDeLaListe[];
  }> {
    if (ids.length === 0) return { purges: 0, conversations: 0, messages: 0, analyses: 0, listeAgent: [] };
    return enTransaction(this.pool, async (client) => {
      // Numéros des contacts visés, lus avant l'anonymisation : le cache RCS est indexé en E.164 (`+33…`), pas en wa_id.
      const cibles = await client.query<{ phone_e164: string | null }>(
        `select phone_e164 from contacts where tenant_id = $1 and id = any($2::uuid[])`,
        [tenantId, ids],
      );
      const e164 = cibles.rows.map((r) => r.phone_e164).filter((p): p is string => p !== null && !p.startsWith('anon:'));
      // Les mesures par bloc sont indexées par wa_id (chiffres nus) : on dérive les numéros visés en plus des wa_id
      // des fils, un contact pouvant avoir des mesures sans conversation.
      const waIdsDuNumero = e164.map((p) => p.replace(/[^0-9]/g, '')).filter((d) => d !== '');

      // Les fils visés, par la règle partagée contact <-> wa_id. Une égalité `conversations.wa_id =
      // contacts.phone_e164` ne serait jamais vraie (`33612345678` contre `+33612345678`) : le fil survivrait à la purge.
      const fils = await client.query<{ id: string; wa_id: string }>(
        `select v.id, v.wa_id from conversations v
          where v.tenant_id = $1 and exists (
            select 1 from contacts c
             where c.tenant_id = $1 and c.id = any($2::uuid[]) and ${matchWaIdPredicat('c.', 'v.wa_id')}
          )`,
        [tenantId, ids],
      );
      const convIds = fils.rows.map((r) => r.id);
      const waIds = fils.rows.map((r) => r.wa_id);

      let messages = 0;
      let analyses = 0;
      if (convIds.length > 0) {
        analyses = (await client.query(`delete from conversation_analysis where conversation_id = any($1::uuid[])`, [convIds])).rowCount ?? 0;
        messages = (await client.query(`delete from conversation_messages where conversation_id = any($1::uuid[])`, [convIds])).rowCount ?? 0;
        await client.query(`delete from conversations where tenant_id = $1 and id = any($2::uuid[])`, [tenantId, convIds]);
      }
      if (waIds.length > 0) {
        // `workflow_runs` et `automation_fires` portent bien un wa_id (chiffres nus), eux.
        await client.query(`delete from workflow_runs where tenant_id = $1 and wa_id = any($2::text[])`, [tenantId, waIds]);
        // `automation_fires` a pour clé (automation_id, wa_id), sans tenant_id : le cloisonnement passe par l'automation.
        await client.query(
          `delete from automation_fires f using automations a
            where a.id = f.automation_id and a.tenant_id = $1 and f.wa_id = any($2::text[])`,
          [tenantId, waIds],
        );
        // Le pendant d'`automation_fires` pour le scénario d'un widget (migration 0201), qui porte, lui, son espace.
        await client.query(`delete from widget_tirs where tenant_id = $1 and wa_id = any($2::text[])`, [tenantId, waIds]);
      }
      // Cache RCS : clé (agent_id, phone_e164). Effacé même sans fil, sinon le numéro resterait dans la table de
      // joignabilité.
      if (e164.length > 0) {
        await client.query(`delete from rcs_capabilities_cache where phone_e164 = any($1::text[])`, [e164]);
      }

      // Mesures par bloc : anonymisées, pas supprimées, pour que les tableaux gardent des compteurs justes.
      const waIdsAAnonymiser = [...new Set([...waIds, ...waIdsDuNumero])];
      if (waIdsAAnonymiser.length > 0) {
        await client.query(
          `update workflow_node_events set wa_id = 'anonyme' where tenant_id = $1 and wa_id = any($2::text[])`,
          [tenantId, waIdsAAnonymiser],
        );
      }

      // `webhook_events` garde le payload brut de chaque événement Meta, texte et numéro compris. La personne est visée
      // par `from` (entrant, echo) ou `recipient_id` (statut). 🔴 Scopé au tenant par le numéro destinataire : la même
      // personne peut écrire à deux de nos clients, et purger chez l'un ne touche pas le journal de l'autre. Hors
      // d'atteinte, couverts par la rétention : les lignes sans `phone_number_id`, et les `messaging_handovers` (sans
      // `from` ni `recipient_id`, ni texte).
      if (waIdsAAnonymiser.length > 0) {
        await client.query(
          `delete from webhook_events
            where (payload->>'from' = any($2::text[]) or payload->>'recipient_id' = any($2::text[]))
              and phone_number_id in (select id from phone_numbers where tenant_id = $1)`,
          [tenantId, waIdsAAnonymiser],
        );
      }

      // La liste de l'agent de Meta (migration 0195) : la ligne part ici, et elle est RENDUE, parce que l'entrée chez
      // Meta ne peut se retirer qu'avec l'identifiant qu'elle porte. La route la retire chez Meta après la validation :
      // un appel à un tiers ne se fait pas dans une transaction qu'il retiendrait ouverte.
      const listeAgent = waIdsAAnonymiser.length === 0 ? [] : (await client.query<{ wa_id: string; phone_number_id: string; entree_id: string }>(
        `delete from mba_liste where tenant_id = $1 and wa_id = any($2::text[]) returning wa_id, phone_number_id, entree_id`,
        [tenantId, waIdsAAnonymiser],
      )).rows.map((r) => ({ waId: r.wa_id, phoneNumberId: r.phone_number_id, entreeId: r.entree_id }));

      // L'échec d'un message libre garde le numéro et le motif : effacé, pas anonymisé (journal d'exploitation, sans
      // quantitatif). Visé par les deux formes du numéro : un échec survit à son fil, et peut précéder le message.
      if (waIdsAAnonymiser.length > 0) {
        await client.query(
          `delete from echecs_messages where tenant_id = $1 and wa_id = any($2::text[])`,
          [tenantId, waIdsAAnonymiser],
        );
      }

      // La ligne de campagne reste (statut, horodatage, livraison) ; son numéro et ses variables partent :
      // `resolved_params` porte les valeurs injectées (typiquement le prénom), `variables` ce que l'intégrateur a
      // passé pour ce destinataire. `null` et pas '{}' : « n'en porte pas ».
      await client.query(
        `update campaign_recipients set to_e164 = 'anonyme', resolved_params = '{}'::jsonb, variables = null
          where contact_id = any($1::uuid[])`,
        [ids],
      );

      // L'arrivée publicitaire : `ctwa_clid` identifie le clic, que Meta sait relier à la personne. La ligne reste pour
      // le compte des leads, l'identifiant part. La cascade de la fiche ne joue pas ici : la purge l'anonymise.
      await client.query(
        `update arrivees_pub set ctwa_clid = null where tenant_id = $1 and contact_id = any($2::uuid[])`,
        [tenantId, ids],
      );

      const res = await client.query(
        `update contacts
            set phone_e164 = 'anon:' || gen_random_uuid(), bsuid = null, profile_name = null,
                fields = '{}'::jsonb, deleted_at = coalesce(deleted_at, now()), anonymized_at = now(),
                -- Le JETON PUBLIC part avec le reste (migration 0106) : il designe cette personne dans des
                -- URL qui circulent encore. Le garder laisserait un identifiant vivant apres l effacement,
                -- et ses clics futurs continueraient de lui etre attribues.
                jeton_public = null,
                -- L IDENTIFIANT EXTERNE part aussi : il designe cette personne dans l outil du client, et il
                -- bloquerait la recreation d une fiche avec le meme identifiant (index unique par espace).
                external_id = null,
                -- Les ETIQUETTES partent (0011) : texte libre pose par l equipe, un import ou un scenario, qui
                -- peut porter un jugement (reclamation, mauvais payeur) ou le nom d une liste. Gardees, elles
                -- restaient comptees sur la page des etiquettes, pour une liste vide au clic.
                tags = '{}',
                -- Le RISQUE part (0178) : un jugement calcule sur la personne, a partir de faits que cette purge
                -- efface. Le balayage de nuit ignore les fiches supprimees : garde, il restait fige pour toujours.
                -- Tout a null, comme une fiche jamais calculee (la contrainte de coherence l accepte).
                risque_niveau = null, risque_score = null, risque_raisons = '{}', risque_calcule_le = null,
                -- La LANGUE DETECTEE part (0137) : tiree des messages effaces ici, elle dit une origine probable.
                langue_detectee = null, langue_detectee_le = null,
                -- La JOIGNABILITE WHATSAPP part (0133) : un fait sur un numero qui n est plus sur la fiche.
                whatsapp_joignable = null, whatsapp_joignable_le = null,
                -- La SOURCE du consentement part : l API publique y ecrit un texte libre de l integrateur, et
                -- un webhook le nom que l equipe lui a donne. Aucun lecteur ne l atteint apres la purge.
                opt_in_source = null,
                -- QUI a bloque part (0071) : un membre de l equipe, que personne ne relit.
                blocked_by = null,
                -- LA DERNIERE ANALYSE part entiere (0196) : des jugements sur la personne (reclamation,
                -- mecontentement, urgence), qui survivent sinon a l effacement de ses conversations, puisque
                -- c est precisement leur objet. Entiere, a cause de sa contrainte de coherence.
                analyse_intention = null, analyse_sentiment = null, analyse_satisfaction = null, analyse_urgence = null,
                analyse_resolue = null, analyse_sujet = null, analyse_traitee_par = null, analyse_action = null,
                analyse_le = null, analyse_fenetre_fin = null, analyse_conversation_id = null,
                -- RESTENT, deliberement : le statut d opt-in et sa date (0138), la date du blocage, le STOP RCS
                -- (0057). Sans numero, un refus n identifie personne, et l effacer est la seule des deux erreurs
                -- qui ne se rattrape pas. Ce ne sont plus eux qui protegent un run de campagne en cours (il tient
                -- le VRAI numero en memoire) : claim relit cette fiche par sa cle primaire juste avant d envoyer,
                -- et ecarte d abord une fiche purgee, par anonymized_at, avant de regarder le STOP et le blocage.
                updated_at = now()
          where tenant_id = $1 and id = any($2::uuid[]) and anonymized_at is null`,
        [tenantId, ids],
      );
      return { purges: res.rowCount ?? 0, conversations: convIds.length, messages, analyses, listeAgent };
    });
  }
}

/**
 * Construit un WHERE paramétré pour requêter les contacts (« Liste de contacts » de campagne, mini-CRM). Fonction
 * pure. 🔴 `tenant_id = $1` et `deleted_at is null` toujours présents. Les valeurs de champ perso sont des
 * chaînes dans le jsonb : comparaison textuelle.
 */
export function buildContactWhere(tenantId: string, f: ContactFilters): { where: string; params: unknown[] } {
  const clauses: string[] = ['tenant_id = $1', 'deleted_at is null'];
  const params: unknown[] = [tenantId];
  const add = (v: unknown): string => { params.push(v); return `$${params.length}`; };

  const tags = (f.tags ?? []).map((t) => t.trim()).filter((t) => t !== '');
  if (tags.length > 0) {
    // AND = contient tous les tags (@>) ; OR = en partage au moins un (&&).
    const op = f.tagMode === 'or' ? '&&' : '@>';
    clauses.push(`tags ${op} ${add(tags)}::text[]`);
  }
  const tagsExclude = (f.tagsExclude ?? []).map((t) => t.trim()).filter((t) => t !== '');
  if (tagsExclude.length > 0) {
    // « Ne possède pas » : `tags` est non-null (défaut '{}'), donc un contact sans tag est inclus.
    clauses.push(`not (tags && ${add(tagsExclude)}::text[])`);
  }
  if (f.optIn === 'opted_in' || f.optIn === 'opted_out' || f.optIn === 'unknown') {
    clauses.push(`opt_in_status = ${add(f.optIn)}`);
  }
  if (f.phonePrefix && f.phonePrefix.trim() !== '') {
    // Préfixe ancré, servi par `contacts_tenant_phone_prefix_idx` (`text_pattern_ops`) : un btree ordinaire suit la
    // collation et ne sait pas borner un préfixe. `+` et chiffres saisis gardés tels quels.
    clauses.push(`phone_e164 like ${add(f.phonePrefix.trim() + '%')}`);
  }
  if (f.phoneContains && f.phoneContains.replace(/\D/g, '') !== '') {
    // Contenu : on compare les chiffres nus des deux côtés (le stocké est en E.164).
    clauses.push(`regexp_replace(coalesce(phone_e164,''), '[^0-9]', '', 'g') like '%' || ${add(f.phoneContains.replace(/\D/g, ''))} || '%'`);
  }
  if (f.nameSearch && f.nameSearch.trim() !== '') {
    clauses.push(`profile_name ilike '%' || ${add(f.nameSearch.trim())} || '%'`);
  }
  if (f.joignabiliteWhatsApp === 'connu_injoignable') {
    // Les trois termes transposent exactement `verdictWhatsApp`, dans son ordre : `null` est inconnu (gardé), une
    // valeur sans date aussi, et une mesure périmée redevient inconnue. En retirer un ferait diverger la liste de la
    // fiche. Le seuil vient de `PEREMPTION_WHATSAPP_MS`, jamais écrit en dur.
    clauses.push(
      `(whatsapp_joignable is not false or whatsapp_joignable_le is null` +
      ` or whatsapp_joignable_le < now() - (${add(PEREMPTION_WHATSAPP_MS)}::bigint * interval '1 millisecond'))`,
    );
  }
  if (f.risque !== undefined) {
    // Égalité nue sur la colonne : un contrat avec l'index `contacts_tenant_risque_idx` (`(tenant_id, risque_niveau)
    // where deleted_at is null`). Un `coalesce` ou un `in (...)` sur une expression sortirait de l'index sans erreur.
    // `tests/contact-where.test.ts` relit la migration.
    clauses.push(`risque_niveau = ${add(f.risque)}`);
  }
  for (const ff of f.fieldFilters ?? []) {
    const key = String(ff.key ?? '').trim();
    if (key === '') continue;
    // Une clé de la dernière analyse va à SA colonne, par la carte fermée de `filtre-fiche` : jamais au jsonb, où un
    // champ perso homonyme ne peut plus naître (clés réservées) mais pourrait exister d'avant.
    if (estCleFiltrable(key)) { clauses.push(clauseFiltreFiche(key, ff.op, ff.value, add)); continue; }
    // Un opérateur de colonne sur un champ perso n'a pas de sens : personne, jamais « pas de filtre ».
    if (estOperateurFicheSeul(ff.op)) { clauses.push('false'); continue; }
    // `fields ->> $key` : la clé jsonb est paramétrée, et son placeholder réutilisé. Ne pousser le param de clé
    // qu'une fois la clause décidée, sinon un filtre sauté laisserait un param orphelin qui décalerait la numérotation.
    if (ff.op === 'empty') { const kr = add(key); clauses.push(`(fields ->> ${kr} is null or fields ->> ${kr} = '')`); continue; }
    if (ff.op === 'not_empty') { const kr = add(key); clauses.push(`(fields ->> ${kr} is not null and fields ->> ${kr} <> '')`); continue; }
    // eq, contains, not_contains : exigent une valeur non vide, sinon le filtre n'est pas posé.
    const val = String(ff.value ?? '');
    if (val === '') continue;
    const kr = add(key);
    if (ff.op === 'contains') clauses.push(`coalesce(fields ->> ${kr}, '') ilike '%' || ${add(val)} || '%'`);
    else if (ff.op === 'not_contains') clauses.push(`coalesce(fields ->> ${kr}, '') not ilike '%' || ${add(val)} || '%'`);
    else clauses.push(`fields ->> ${kr} = ${add(val)}`);
  }
  return { where: clauses.join(' and '), params };
}

/**
 * Construit le WHERE d'une action en masse. Ids explicites -> `id = any($ids)`, scopé tenant et actif ; filtres
 * -> `buildContactWhere`, puis exclusion des ids décochés. Fonction pure.
 */
export function buildBulkSelector(tenantId: string, target: BulkTarget): { where: string; params: unknown[] } {
  if ('ids' in target) {
    const ids = [...new Set(target.ids.filter((id) => typeof id === 'string' && id.trim() !== ''))];
    // Cible vide -> WHERE impossible (`false`) : aucune ligne touchée (jamais un UPDATE global par erreur).
    if (ids.length === 0) return { where: 'false', params: [] };
    return { where: 'tenant_id = $1 and deleted_at is null and id = any($2::uuid[])', params: [tenantId, ids] };
  }
  const { where, params } = buildContactWhere(tenantId, target.filters);
  const excludeIds = [...new Set((target.excludeIds ?? []).filter((id) => typeof id === 'string' && id.trim() !== ''))];
  if (excludeIds.length === 0) return { where, params };
  const p = [...params];
  p.push(excludeIds);
  return { where: `${where} and not (id = any($${p.length}::uuid[]))`, params: p };
}
