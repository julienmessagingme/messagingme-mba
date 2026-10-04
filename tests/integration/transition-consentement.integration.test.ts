// tests/integration/transition-consentement.integration.test.ts
import '../../src/charger-env';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgContactStore } from '../../src/crm/contact-store.pg';
import type { StatutConsentement } from '../../src/crm/transition-consentement';

/**
 * LA TRANSITION DU CONSENTEMENT, ÉCRITURE PAR ÉCRITURE, CONTRE UNE VRAIE BASE (`src/crm/transition-consentement.ts`).
 *
 * Pour chacune des six écritures de `PgContactStore`, chaque état de départ (fiche absente, `unknown`, `opted_in`,
 * `opted_out`) et chaque demande : le statut, la date du désabonnement (posée, remise à null, inchangée), la source,
 * et les `wa_id` annoncés au système du client. Elle remplace les tests qui reconnaissaient le SQL par expressions
 * régulières : ceux-là prouvaient qu'une garde PART, pas qu'elle est JUSTE.
 *
 * 🔴 Les quatre changements du 2026-10-03 y sont tenus : (1) un statut inchangé ne réécrit rien et ne s'annonce pas,
 * partout ; (2) l'action en masse ne lève plus un STOP et compte les STOP gardés ; (3) une fiche créée `opted_out`
 * porterait sa date (aucun chemin n'en crée : mesuré, cf. le module) ; (4) l'annonce ne part que pour un vrai passage
 * à `opted_out`, après le `commit`. Plus la course de deux STOP simultanés : une seule annonce.
 *
 * ⚠️ Chaque annonce relit le statut de ses fiches par UNE AUTRE connexion au moment où elle part : `opted_out` prouve
 * que l'écriture était déjà validée. Jamais joué en local (le DATABASE_URL local pointe la PRODUCTION), joué par le job
 * `integration`.
 */
const url = process.env.DATABASE_URL ?? '';

/** La date et le `updated_at` posés au départ : tout ce qui ne bouge pas doit la garder. */
const D0 = new Date('2026-09-01T10:00:00.000Z');
const SOURCE_D_ORIGINE = 'origine';

type Depart = 'absente' | StatutConsentement;
interface Fiche { id: string; phone: string; waId: string }
interface Annonce { waIds: string[]; message?: string; statutsVus: string[] }

/** Ce qu'une écriture doit laisser. `statut: null` : aucune fiche (rien n'est créé). */
interface Attendu {
  rend?: unknown;
  statut: StatutConsentement | null;
  date: 'posee' | 'nulle' | 'inchangee';
  /** La source attendue ; `SOURCE_D_ORIGINE` = celle du départ, gardée. */
  source: string | null;
  annonce: boolean;
  /** 🔴 Rien n'est réécrit, `updated_at` compris (une écriture qui ne porte que le consentement). */
  intacte?: true;
}

interface Cas extends Attendu {
  ecriture: string;
  depart: Depart;
  demande: string;
  jouer: (f: Fiche) => Promise<unknown>;
}

describe.skipIf(!url)('la transition du consentement (Postgres)', () => {
  let pool: Pool;
  let store: PgContactStore;
  let tenantId = '';
  let autreTenantId = '';
  const annonces: Annonce[] = [];

  beforeAll(async () => {
    // Six connexions : la course ouvre un verrou à part et deux écritures concurrentes, l'annonce relit à côté.
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 6 });
    store = new PgContactStore(pool, async (t, waIds, message) => {
      const vus = await pool.query<{ opt_in_status: string }>(
        `select opt_in_status from contacts where tenant_id = $1 and phone_e164 = any($2::text[])`,
        [t, waIds.map((w) => `+${w}`)],
      );
      annonces.push({ waIds: [...waIds].sort(), ...(message ? { message } : {}), statutsVus: vus.rows.map((r) => r.opt_in_status) });
    });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-transition-consentement') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-transition-voisin') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  beforeEach(() => { annonces.length = 0; });

  let n = 0;
  /** Une fiche neuve dans l'état de départ, posée en SQL nu : la table ne dépend pas du code qu'elle juge. */
  async function poser(depart: Depart, espace = tenantId): Promise<Fiche> {
    n += 1;
    const phone = `+3361${String(n).padStart(7, '0')}`;
    const waId = phone.slice(1);
    if (depart === 'absente') return { id: randomUUID(), phone, waId };
    const r = await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, opt_in_status, opt_in_source, opt_out_at, updated_at)
       values ($1, $2, $3::text, $4, case when $3::text = 'opted_out' then $5::timestamptz end, $5::timestamptz)
       returning id`,
      [espace, phone, depart, SOURCE_D_ORIGINE, D0],
    );
    return { id: r.rows[0]!.id, phone, waId };
  }

  async function lire(phone: string): Promise<{ opt_in_status: string; opt_in_source: string | null; opt_out_at: Date | null; updated_at: Date } | null> {
    const r = await pool.query<{ opt_in_status: string; opt_in_source: string | null; opt_out_at: Date | null; updated_at: Date }>(
      'select opt_in_status, opt_in_source, opt_out_at, updated_at from contacts where tenant_id = $1 and phone_e164 = $2',
      [tenantId, phone],
    );
    return r.rows[0] ?? null;
  }

  /** Vérifie une fiche contre ce qu'on attend d'elle. */
  async function verifier(f: Fiche, depart: Depart, a: Attendu, contexte: string): Promise<void> {
    const l = await lire(f.phone);
    if (a.statut === null) {
      expect(l, `${contexte} : aucune fiche ne doit exister`).toBeNull();
      return;
    }
    expect(l, `${contexte} : la fiche doit exister`).not.toBeNull();
    expect(l!.opt_in_status, `${contexte} : statut`).toBe(a.statut);
    expect(l!.opt_in_source, `${contexte} : source`).toBe(a.source);
    if (a.date === 'nulle') expect(l!.opt_out_at, `${contexte} : date`).toBeNull();
    if (a.date === 'posee') expect(l!.opt_out_at!.getTime(), `${contexte} : date posée maintenant`).toBeGreaterThan(D0.getTime());
    if (a.date === 'inchangee') {
      expect(l!.opt_out_at?.toISOString() ?? null, `${contexte} : date inchangée`).toBe(depart === 'opted_out' ? D0.toISOString() : null);
    }
    if (a.intacte) expect(l!.updated_at.toISOString(), `${contexte} : rien n'est réécrit`).toBe(D0.toISOString());
  }

  // Les demandes des six écritures, avec leur autorité et leur source.
  const unitaire = (voulu: 'opted_in' | 'unknown') => (f: Fiche) => store.upsertByPhoneReturningId({
    tenantId, phoneE164: f.phone, profileName: null, fields: { ville: 'Lyon' }, optInStatus: voulu,
    ...(voulu === 'opted_in' ? { optInSource: 'webhook:crm' } : {}),
  });
  const lot = (autorite: 'import' | 'import_csv_coche', voulu: 'opted_in' | 'unknown', source: string) => (f: Fiche) => store.upsertManyByPhone({
    tenantId, autorite, optInStatus: voulu, ...(voulu === 'opted_in' ? { optInSource: source } : {}),
    contacts: [{ phoneE164: f.phone, profileName: null, fields: {} }],
  });
  const parWaId = (statut: 'opted_in' | 'opted_out', autorite: 'personne' | 'scenario', source: string) =>
    (f: Fiche) => store.setOptInByWaId(tenantId, f.waId, statut, autorite, source, statut === 'opted_out' ? `wamid.${f.waId}` : undefined);
  const api = (statut: 'opted_in' | 'opted_out', source: string) => (f: Fiche) => store.ecrireConsentementParId(tenantId, f.id, statut, source);
  const fiche = (statut: 'opted_in' | 'opted_out') => async (f: Fiche) =>
    (await store.applyEdits(tenantId, f.id, { fields: {}, addTags: [], removeTags: [], optInStatus: statut }))?.contact.optInStatus ?? null;

  const GARDE = { date: 'inchangee', source: SOURCE_D_ORIGINE, annonce: false } as const;

  const CAS: Cas[] = [
    // ---- upsertByPhoneReturningId : webhook entrant et création à la main, autorité `webhook_ou_saisie` ----
    { ecriture: 'upsert unitaire', depart: 'absente', demande: 'opted_in', jouer: unitaire('opted_in'), statut: 'opted_in', date: 'nulle', source: 'webhook:crm', annonce: false },
    { ecriture: 'upsert unitaire', depart: 'absente', demande: 'unknown', jouer: unitaire('unknown'), statut: 'unknown', date: 'nulle', source: null, annonce: false },
    { ecriture: 'upsert unitaire', depart: 'unknown', demande: 'opted_in', jouer: unitaire('opted_in'), statut: 'opted_in', date: 'nulle', source: 'webhook:crm', annonce: false },
    { ecriture: 'upsert unitaire', depart: 'unknown', demande: 'unknown', jouer: unitaire('unknown'), statut: 'unknown', ...GARDE },
    // 🔴 Changement (1) : la source d'un consentement déjà posé n'est plus remplacée.
    { ecriture: 'upsert unitaire', depart: 'opted_in', demande: 'opted_in', jouer: unitaire('opted_in'), statut: 'opted_in', ...GARDE },
    { ecriture: 'upsert unitaire', depart: 'opted_in', demande: 'unknown', jouer: unitaire('unknown'), statut: 'opted_in', ...GARDE },
    // 🔴 Un STOP ne se lève pas par le webhook entrant ni par la création à la main : statut, date ET source gardés.
    { ecriture: 'upsert unitaire', depart: 'opted_out', demande: 'opted_in', jouer: unitaire('opted_in'), statut: 'opted_out', ...GARDE },
    { ecriture: 'upsert unitaire', depart: 'opted_out', demande: 'unknown', jouer: unitaire('unknown'), statut: 'opted_out', ...GARDE },

    // ---- upsertManyByPhone sans la case (HubSpot, import sans case), autorité `import` ----
    { ecriture: 'import (HubSpot)', depart: 'absente', demande: 'opted_in', jouer: lot('import', 'opted_in', 'hubspot_list'), statut: 'opted_in', date: 'nulle', source: 'hubspot_list', annonce: false },
    { ecriture: 'import (HubSpot)', depart: 'unknown', demande: 'opted_in', jouer: lot('import', 'opted_in', 'hubspot_list'), statut: 'opted_in', date: 'nulle', source: 'hubspot_list', annonce: false },
    { ecriture: 'import (HubSpot)', depart: 'opted_in', demande: 'opted_in', jouer: lot('import', 'opted_in', 'hubspot_list'), statut: 'opted_in', ...GARDE },
    { ecriture: 'import (HubSpot)', depart: 'opted_out', demande: 'opted_in', jouer: lot('import', 'opted_in', 'hubspot_list'), statut: 'opted_out', ...GARDE },
    { ecriture: 'import sans case', depart: 'opted_out', demande: 'unknown', jouer: lot('import', 'unknown', ''), statut: 'opted_out', ...GARDE },
    { ecriture: 'import sans case', depart: 'opted_in', demande: 'unknown', jouer: lot('import', 'unknown', ''), statut: 'opted_in', ...GARDE },

    // ---- upsertManyByPhone case cochée, autorité `import_csv_coche` : le seul import qui lève un STOP ----
    { ecriture: 'import CSV coché', depart: 'absente', demande: 'opted_in', jouer: lot('import_csv_coche', 'opted_in', 'csv_import'), statut: 'opted_in', date: 'nulle', source: 'csv_import', annonce: false },
    { ecriture: 'import CSV coché', depart: 'unknown', demande: 'opted_in', jouer: lot('import_csv_coche', 'opted_in', 'csv_import'), statut: 'opted_in', date: 'nulle', source: 'csv_import', annonce: false },
    { ecriture: 'import CSV coché', depart: 'opted_in', demande: 'opted_in', jouer: lot('import_csv_coche', 'opted_in', 'csv_import'), statut: 'opted_in', ...GARDE },
    { ecriture: 'import CSV coché', depart: 'opted_out', demande: 'opted_in', jouer: lot('import_csv_coche', 'opted_in', 'csv_import'), statut: 'opted_in', date: 'nulle', source: 'csv_import', annonce: false },

    // ---- setOptInByWaId, autorité `personne` : le mot STOP, le formulaire WhatsApp coché ----
    { ecriture: 'mot STOP', depart: 'absente', demande: 'opted_out', jouer: parWaId('opted_out', 'personne', 'whatsapp_stop'), rend: null, statut: null, date: 'nulle', source: null, annonce: false },
    { ecriture: 'mot STOP', depart: 'unknown', demande: 'opted_out', jouer: parWaId('opted_out', 'personne', 'whatsapp_stop'), statut: 'opted_out', date: 'posee', source: 'whatsapp_stop', annonce: true },
    { ecriture: 'mot STOP', depart: 'opted_in', demande: 'opted_out', jouer: parWaId('opted_out', 'personne', 'whatsapp_stop'), statut: 'opted_out', date: 'posee', source: 'whatsapp_stop', annonce: true },
    // Un second STOP : la fiche est rendue, rien n'est réécrit, rien ne s'annonce.
    { ecriture: 'mot STOP', depart: 'opted_out', demande: 'opted_out', jouer: parWaId('opted_out', 'personne', 'whatsapp_stop'), statut: 'opted_out', ...GARDE, intacte: true },
    { ecriture: 'formulaire coché', depart: 'unknown', demande: 'opted_in', jouer: (f) => store.markOptedIn(tenantId, f.waId, 'flow'), statut: 'opted_in', date: 'nulle', source: 'flow', annonce: false },
    { ecriture: 'formulaire coché', depart: 'opted_in', demande: 'opted_in', jouer: (f) => store.markOptedIn(tenantId, f.waId, 'flow'), statut: 'opted_in', ...GARDE, intacte: true },
    // 🔴 La personne lève son propre STOP.
    { ecriture: 'formulaire coché', depart: 'opted_out', demande: 'opted_in', jouer: (f) => store.markOptedIn(tenantId, f.waId, 'flow'), statut: 'opted_in', date: 'nulle', source: 'flow', annonce: false },

    // ---- setOptInByWaId, autorité `scenario` : le bloc « Action » ----
    { ecriture: 'bloc Action', depart: 'opted_in', demande: 'opted_out', jouer: parWaId('opted_out', 'scenario', 'scenario'), statut: 'opted_out', date: 'posee', source: 'scenario', annonce: true },
    { ecriture: 'bloc Action', depart: 'opted_out', demande: 'opted_out', jouer: parWaId('opted_out', 'scenario', 'scenario'), statut: 'opted_out', ...GARDE, intacte: true },
    { ecriture: 'bloc Action', depart: 'unknown', demande: 'opted_in', jouer: parWaId('opted_in', 'scenario', 'scenario'), statut: 'opted_in', date: 'nulle', source: 'scenario', annonce: false },
    { ecriture: 'bloc Action', depart: 'opted_out', demande: 'opted_in', jouer: parWaId('opted_in', 'scenario', 'scenario'), statut: 'opted_in', date: 'nulle', source: 'scenario', annonce: false },

    // ---- ecrireConsentementParId, autorité `api` : un STOP rend `refuse` ----
    { ecriture: 'API', depart: 'absente', demande: 'opted_out', jouer: api('opted_out', 'api'), rend: 'absente', statut: null, date: 'nulle', source: null, annonce: false },
    { ecriture: 'API', depart: 'unknown', demande: 'opted_out', jouer: api('opted_out', 'api'), rend: 'change', statut: 'opted_out', date: 'posee', source: 'api', annonce: true },
    { ecriture: 'API', depart: 'opted_in', demande: 'opted_out', jouer: api('opted_out', 'api'), rend: 'change', statut: 'opted_out', date: 'posee', source: 'api', annonce: true },
    { ecriture: 'API', depart: 'opted_out', demande: 'opted_out', jouer: api('opted_out', 'api'), rend: 'inchange', statut: 'opted_out', ...GARDE, intacte: true },
    { ecriture: 'API', depart: 'unknown', demande: 'opted_in', jouer: api('opted_in', 'formulaire-site'), rend: 'change', statut: 'opted_in', date: 'nulle', source: 'formulaire-site', annonce: false },
    { ecriture: 'API', depart: 'opted_in', demande: 'opted_in', jouer: api('opted_in', 'formulaire-site'), rend: 'inchange', statut: 'opted_in', ...GARDE, intacte: true },
    { ecriture: 'API', depart: 'opted_out', demande: 'opted_in', jouer: api('opted_in', 'formulaire-site'), rend: 'refuse', statut: 'opted_out', ...GARDE, intacte: true },

    // ---- applyEdits, autorité `fiche` : un opérateur devant la fiche, qui lève un STOP ----
    { ecriture: 'fiche', depart: 'absente', demande: 'opted_out', jouer: fiche('opted_out'), rend: null, statut: null, date: 'nulle', source: null, annonce: false },
    { ecriture: 'fiche', depart: 'unknown', demande: 'opted_out', jouer: fiche('opted_out'), rend: 'opted_out', statut: 'opted_out', date: 'posee', source: 'crm', annonce: true },
    { ecriture: 'fiche', depart: 'opted_in', demande: 'opted_out', jouer: fiche('opted_out'), rend: 'opted_out', statut: 'opted_out', date: 'posee', source: 'crm', annonce: true },
    // 🔴 Changement (1) : se désabonner puis enregistrer à nouveau ne repousse pas la date et ne réannonce pas.
    { ecriture: 'fiche', depart: 'opted_out', demande: 'opted_out', jouer: fiche('opted_out'), rend: 'opted_out', statut: 'opted_out', ...GARDE, intacte: true },
    { ecriture: 'fiche', depart: 'unknown', demande: 'opted_in', jouer: fiche('opted_in'), rend: 'opted_in', statut: 'opted_in', date: 'nulle', source: 'crm', annonce: false },
    { ecriture: 'fiche', depart: 'opted_in', demande: 'opted_in', jouer: fiche('opted_in'), rend: 'opted_in', statut: 'opted_in', ...GARDE, intacte: true },
    { ecriture: 'fiche', depart: 'opted_out', demande: 'opted_in', jouer: fiche('opted_in'), rend: 'opted_in', statut: 'opted_in', date: 'nulle', source: 'crm', annonce: false },
  ];

  for (const c of CAS) {
    it(`${c.ecriture} : ${c.depart} + ${c.demande} -> ${c.statut ?? 'aucune fiche'}${c.annonce ? ', annoncé' : ''}`, async () => {
      const f = await poser(c.depart);
      const rendu = await c.jouer(f);
      if ('rend' in c) expect(rendu, 'valeur rendue').toEqual(c.rend);
      await verifier(f, c.depart, c, c.ecriture);
      // 🔴 Changement (4) : l'annonce ne part que pour un vrai passage à `opted_out`, après le `commit`.
      expect(annonces.map((a) => a.waIds)).toEqual(c.annonce ? [[f.waId]] : []);
      for (const a of annonces) expect(a.statutsVus, 'l’annonce lit une écriture déjà validée').toEqual(['opted_out']);
    });
  }

  it('le mot STOP passe l’identifiant de son message à l’annonce', async () => {
    const f = await poser('opted_in');
    await store.setOptInByWaId(tenantId, f.waId, 'opted_out', 'personne', 'whatsapp_stop', 'wamid.le-stop');
    expect(annonces).toEqual([{ waIds: [f.waId], message: 'wamid.le-stop', statutsVus: ['opted_out'] }]);
  });

  it('setOptInByWaId rend la fiche écrite OU NON, et ne crée jamais de fiche', async () => {
    const f = await poser('opted_out');
    expect(await store.setOptInByWaId(tenantId, f.waId, 'opted_out', 'scenario', 'scenario')).toBe(f.id);
    const inconnue = await poser('absente');
    expect(await store.setOptInByWaId(tenantId, inconnue.waId, 'opted_in', 'scenario', 'scenario')).toBeNull();
    expect(await lire(inconnue.phone)).toBeNull();
  });

  it('🔴 l’API ne voit ni une fiche supprimée ni la fiche d’un autre espace : `absente`, rien d’écrit', async () => {
    const supprimee = await poser('opted_in');
    await pool.query('update contacts set deleted_at = now() where id = $1', [supprimee.id]);
    expect(await store.ecrireConsentementParId(tenantId, supprimee.id, 'opted_out', 'api')).toBe('absente');
    expect((await lire(supprimee.phone))!.opt_in_status).toBe('opted_in');

    const voisine = await poser('opted_in', autreTenantId);
    expect(await store.ecrireConsentementParId(tenantId, voisine.id, 'opted_out', 'api')).toBe('absente');
    const lue = await pool.query<{ opt_in_status: string }>('select opt_in_status from contacts where id = $1', [voisine.id]);
    expect(lue.rows[0]!.opt_in_status).toBe('opted_in');
    expect(annonces).toEqual([]);
  });

  it('🔴 la fiche d’un autre espace n’est pas éditable depuis celui-ci (applyEdits rend null)', async () => {
    const voisine = await poser('opted_in', autreTenantId);
    expect(await store.applyEdits(tenantId, voisine.id, { fields: {}, addTags: [], removeTags: [], optInStatus: 'opted_out' })).toBeNull();
    expect(annonces).toEqual([]);
  });

  /**
   * ⚠️ Changement (3), mesuré : aucune écriture ne CRÉE une fiche `opted_out`. L'API publique crée en `unknown`
   * (`creerFicheApi`) puis écrit le consentement : le passage pose la date, et il s'annonce comme tout passage.
   * ⚠️ Le plan voulait « aucune annonce » pour une fiche créée `opted_out` par l'API (le refus vient du système du
   * client) ; ce cas fige le comportement mesuré, à trancher par Julien.
   */
  it('l’API qui crée une fiche puis la désabonne : la date est posée, le passage s’annonce', async () => {
    const f = await poser('absente');
    const creee = await store.creerFicheApi(tenantId, { phoneE164: f.phone });
    if (creee === 'conflit') throw new Error('création refusée');
    expect((await lire(f.phone))!.opt_in_status).toBe('unknown');
    expect(await store.ecrireConsentementParId(tenantId, creee.id, 'opted_out', 'api')).toBe('change');
    const l = (await lire(f.phone))!;
    expect(l.opt_in_status).toBe('opted_out');
    expect(l.opt_out_at).not.toBeNull();
    expect(annonces.map((a) => a.waIds)).toEqual([[f.waId]]);
  });

  describe('l’action en masse, autorité `action_en_masse`', () => {
    /**
     * 🔴 Changement (2) : la masse ne lève plus un STOP, et dit combien de fiches l'ont gardé. Changement (1) : une
     * fiche déjà au statut demandé n'est pas réécrite (sa source et sa date restent), et `affected` ne la compte pas.
     */
    it('🔴 « abonner » : l’inconnu passe, l’abonné reste intact, le STOP est gardé et compté', async () => {
      const [inconnu, abonne, stop] = [await poser('unknown'), await poser('opted_in'), await poser('opted_out')];
      const r = await store.applyEditsMany(tenantId, { ids: [inconnu.id, abonne.id, stop.id] }, { setOptIn: 'opted_in' });
      expect(r).toEqual({ affected: 1, stopsGardes: 1 });
      await verifier(inconnu, 'unknown', { statut: 'opted_in', date: 'nulle', source: 'crm', annonce: false }, 'inconnu');
      await verifier(abonne, 'opted_in', { statut: 'opted_in', ...GARDE, intacte: true }, 'abonné');
      await verifier(stop, 'opted_out', { statut: 'opted_out', ...GARDE, intacte: true }, 'STOP');
      expect(annonces).toEqual([]);
    });

    /** 🔴 Changement (4) : la fiche déjà désabonnée ne repart pas chez le client, et sa date ne bouge pas. */
    it('🔴 « désabonner » : seuls les vrais passages s’annoncent, en un geste ; le STOP en place ne bouge pas', async () => {
      const [inconnu, abonne, stop] = [await poser('unknown'), await poser('opted_in'), await poser('opted_out')];
      const r = await store.applyEditsMany(tenantId, { ids: [inconnu.id, abonne.id, stop.id] }, { setOptIn: 'opted_out' });
      expect(r).toEqual({ affected: 2, stopsGardes: 0 });
      await verifier(inconnu, 'unknown', { statut: 'opted_out', date: 'posee', source: 'crm', annonce: true }, 'inconnu');
      await verifier(abonne, 'opted_in', { statut: 'opted_out', date: 'posee', source: 'crm', annonce: true }, 'abonné');
      await verifier(stop, 'opted_out', { statut: 'opted_out', ...GARDE, intacte: true }, 'STOP');
      expect(annonces).toHaveLength(1);
      expect(annonces[0]!.waIds).toEqual([inconnu.waId, abonne.waId].sort());
      expect(annonces[0]!.statutsVus).toEqual(['opted_out', 'opted_out']);
    });

    it('une cible par FILTRES compte les STOP gardés de toute la sélection', async () => {
      const etiquette = `masse-${randomUUID().slice(0, 8)}`;
      const fiches = [await poser('opted_out'), await poser('opted_out'), await poser('unknown')];
      await pool.query('update contacts set tags = array[$2::text] where id = any($1::uuid[])', [fiches.map((f) => f.id), etiquette]);
      const r = await store.applyEditsMany(tenantId, { filters: { tags: [etiquette] } }, { setOptIn: 'opted_in' });
      expect(r).toEqual({ affected: 1, stopsGardes: 2 });
    });

    it('consentement ET étiquette dans le même geste : l’étiquette se pose partout, le STOP reste entier', async () => {
      const stop = await poser('opted_out');
      const r = await store.applyEditsMany(tenantId, { ids: [stop.id] }, { setOptIn: 'opted_in', addTags: ['salon'] });
      expect(r).toEqual({ affected: 1, stopsGardes: 1 });
      const l = (await pool.query<{ tags: string[]; opt_in_status: string; opt_in_source: string; opt_out_at: Date }>(
        'select tags, opt_in_status, opt_in_source, opt_out_at from contacts where id = $1', [stop.id],
      )).rows[0]!;
      expect(l.tags).toEqual(['salon']);
      expect(l).toMatchObject({ opt_in_status: 'opted_out', opt_in_source: SOURCE_D_ORIGINE });
      expect(l.opt_out_at.toISOString()).toBe(D0.toISOString());
    });

    it('une cible d’un autre espace : rien n’est écrit, rien ne s’annonce', async () => {
      const voisine = await poser('opted_in', autreTenantId);
      expect(await store.applyEditsMany(tenantId, { ids: [voisine.id] }, { setOptIn: 'opted_out' })).toEqual({ affected: 0, stopsGardes: 0 });
      expect(annonces).toEqual([]);
    });
  });

  /**
   * 🔴 DEUX STOP SIMULTANÉS, UNE SEULE ANNONCE. Un verrou tenu à part retient la fiche ; les deux écritures partent et
   * attendent, puis passent l'une après l'autre. La seconde doit relire `opted_out` SOUS VERROU : sans le
   * `for update` de `ecritureDuConsentement`, elle lirait « abonné » dans son instantané et annoncerait aussi.
   */
  async function sousVerrou(f: Fiche, ecritures: () => Promise<unknown>[]): Promise<unknown[]> {
    const verrou = await pool.connect();
    let enCours: Promise<unknown>[] = [];
    try {
      await verrou.query('begin');
      await verrou.query('select 1 from contacts where id = $1 for update', [f.id]);
      enCours = ecritures();
      // Les deux écritures doivent ATTENDRE le verrou avant qu'on le relâche, sinon la course n'a pas eu lieu.
      let attentes = 0;
      for (let i = 0; i < 100 && attentes < 2; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
        attentes = Number((await pool.query<{ n: string }>(
          `select count(*)::text as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock' and query like '%with avant as%'`,
        )).rows[0]!.n);
      }
      expect(attentes, 'les deux écritures n’ont pas attendu le verrou : la course n’a pas été jouée').toBe(2);
    } finally {
      // Relâché dans tous les cas : une connexion rendue au pool en pleine transaction garderait le verrou.
      await verrou.query('rollback').catch(() => {});
      verrou.release();
    }
    return Promise.all(enCours);
  }

  it('🔴 deux STOP simultanés : une seule annonce, la date du premier', async () => {
    const f = await poser('opted_in');
    const rendus = await sousVerrou(f, () => [
      store.setOptInByWaId(tenantId, f.waId, 'opted_out', 'personne', 'whatsapp_stop', 'wamid.course-1'),
      store.setOptInByWaId(tenantId, f.waId, 'opted_out', 'scenario', 'scenario'),
    ]);
    expect(rendus).toEqual([f.id, f.id]);
    expect(annonces.map((a) => a.waIds)).toEqual([[f.waId]]);
    expect((await lire(f.phone))!.opt_in_status).toBe('opted_out');
  });

  it('🔴 deux désabonnements simultanés par l’API : un `change`, un `inchange`, une seule annonce', async () => {
    const f = await poser('opted_in');
    const rendus = await sousVerrou(f, () => [
      store.ecrireConsentementParId(tenantId, f.id, 'opted_out', 'api'),
      store.ecrireConsentementParId(tenantId, f.id, 'opted_out', 'api'),
    ]);
    expect([...rendus].sort()).toEqual(['change', 'inchange']);
    expect(annonces.map((a) => a.waIds)).toEqual([[f.waId]]);
  });
});
