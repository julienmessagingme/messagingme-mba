import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgUserStore } from '../../src/user/store.pg';
import { PgUserAuthStore } from '../../src/auth/store';
import { PgMfaStore } from '../../src/auth/mfa-store.pg';
import { genererCodesSecours, genererSecret, empreinteCodeSecours } from '../../src/auth/totp';

/**
 * LE SECOND FACTEUR, contre une VRAIE base (migration 0182).
 *
 * 🔴 CE QU'AUCUN TEST UNITAIRE NE VOIT : que la consommation d'un code de secours et l'écriture du pas sont
 * ATOMIQUES (deux présentations simultanées, une seule gagne), que le secret est CHIFFRÉ en base, que
 * l'activation ne remplace jamais un facteur actif, et que la réinitialisation par un admin d'espace refuse une
 * identité qui a un compte ailleurs.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION. La CI monte
 * un Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('le second facteur, en base', () => {
  let pool: Pool;
  let users: PgUserStore;
  let auth: PgUserAuthStore;
  let mfa: PgMfaStore;
  const cle = randomBytes(32).toString('hex');
  const suffixe = `${Date.now()}.${randomBytes(3).toString('hex')}`;
  const tenants: string[] = [];
  const emails = new Set<string>();

  async function espace(nom: string, email: string): Promise<{ tenantId: string; userId: string; identityId: string }> {
    const r = await users.createTenantWithAdmin(nom, { email, name: null, passwordHash: 'scrypt$aa$bb' });
    tenants.push(r.tenantId);
    emails.add(email);
    const etat = await mfa.lireParCompte(r.userId);
    return { ...r, identityId: etat!.identityId };
  }

  /** Un facteur actif au pas 100, avec dix codes de secours dont on garde le clair. */
  async function facteurActif(identityId: string): Promise<{ secret: string; clairs: string[] }> {
    const secret = genererSecret();
    const { clairs, empreintes } = genererCodesSecours();
    await mfa.poserSecretEnAttente(identityId, secret);
    expect(await mfa.activer(identityId, secret, 100, empreintes)).toBe(true);
    return { secret, clairs };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    users = new PgUserStore(pool);
    auth = new PgUserAuthStore(pool);
    mfa = new PgMfaStore(pool, cle);
  });

  afterAll(async () => {
    for (const t of tenants) await pool.query('delete from tenants where id = $1', [t]);
    // Les comptes sont partis avec leurs espaces : les identités ne sont plus référencées, et leurs codes suivent
    // par la cascade de 0182.
    await pool.query('delete from identities where lower(email) = any($1::text[])', [[...emails].map((e) => e.toLowerCase())]);
    await pool.end();
  });

  it('🔴 l’activation CHIFFRE le secret, et la connexion par mot de passe voit le facteur actif', async () => {
    const email = `mfa.actif.${suffixe}@exemple.fr`;
    const { userId, identityId } = await espace('itest-mfa-actif', email);
    const avant = await mfa.lireParCompte(userId);
    expect(avant).toMatchObject({ identityId, secret: null, activeLe: null, dernierPas: null, codesSecoursRestants: 0, obligatoire: true });
    expect(await auth.findIdentity(email)).toMatchObject({ identityId, mfaActif: false });

    const secret = genererSecret();
    await mfa.poserSecretEnAttente(identityId, secret);
    expect((await mfa.lire(identityId))!.secretEnAttente).toBe(secret);
    const { empreintes } = genererCodesSecours();
    expect(await mfa.activer(identityId, secret, 100, empreintes)).toBe(true);

    const brut = (await pool.query<{ mfa_secret_enc: string; mfa_secret_attente_enc: string | null }>(
      'select mfa_secret_enc, mfa_secret_attente_enc from identities where id = $1', [identityId],
    )).rows[0]!;
    expect(brut.mfa_secret_enc).toMatch(/^v1\./);
    expect(brut.mfa_secret_enc).not.toContain(secret);
    expect(brut.mfa_secret_attente_enc).toBeNull();
    const codes = (await pool.query<{ code_hash: string }>('select code_hash from mfa_codes_secours where identity_id = $1', [identityId])).rows;
    expect(codes.map((c) => c.code_hash).sort()).toEqual([...empreintes].sort());

    expect(await auth.findIdentity(email)).toMatchObject({ identityId, mfaActif: true });
    expect(await mfa.lire(identityId)).toMatchObject({ secret, dernierPas: 100, codesSecoursRestants: 10 });

    // 🔴 Une seconde activation ne REMPLACE pas le facteur actif : c'est ce qui rend un jeton d'enrôlement inoffensif.
    expect(await mfa.activer(identityId, genererSecret(), 200, empreintes)).toBe(false);
    expect((await mfa.lire(identityId))!.secret).toBe(secret);
  });

  it('🔴 un code de secours ne sert qu’UNE fois, même présenté deux fois EN MÊME TEMPS', async () => {
    const { identityId } = await espace('itest-mfa-secours', `mfa.secours.${suffixe}@exemple.fr`);
    const { clairs } = await facteurActif(identityId);
    const empreinte = empreinteCodeSecours(clairs[0]!)!;
    const resultats = await Promise.all([mfa.consommerCodeSecours(identityId, empreinte), mfa.consommerCodeSecours(identityId, empreinte)]);
    expect(resultats.filter(Boolean)).toHaveLength(1);
    expect(await mfa.consommerCodeSecours(identityId, empreinte)).toBe(false);
    expect((await mfa.lire(identityId))!.codesSecoursRestants).toBe(9);
    // Un code d'une AUTRE identité ne se consomme pas ici.
    const { identityId: autre } = await espace('itest-mfa-secours-autre', `mfa.secours.autre.${suffixe}@exemple.fr`);
    const { clairs: autres } = await facteurActif(autre);
    expect(await mfa.consommerCodeSecours(identityId, empreinteCodeSecours(autres[0]!)!)).toBe(false);
  });

  it('🔴 le pas ne fait que monter, et deux écritures simultanées du même pas : une seule gagne', async () => {
    const { identityId } = await espace('itest-mfa-pas', `mfa.pas.${suffixe}@exemple.fr`);
    await facteurActif(identityId);
    expect(await mfa.marquerPas(identityId, 100)).toBe(false);
    const resultats = await Promise.all([mfa.marquerPas(identityId, 101), mfa.marquerPas(identityId, 101)]);
    expect(resultats.filter(Boolean)).toHaveLength(1);
    expect(await mfa.marquerPas(identityId, 101)).toBe(false);
    expect(await mfa.marquerPas(identityId, 103)).toBe(true);
    expect(await mfa.marquerPas(identityId, 102)).toBe(false);
  });

  it('régénérer remplace les codes, et rien ne se régénère sans facteur actif', async () => {
    const { identityId } = await espace('itest-mfa-regen', `mfa.regen.${suffixe}@exemple.fr`);
    const { identityId: sansFacteur } = await espace('itest-mfa-regen-sans', `mfa.regen.sans.${suffixe}@exemple.fr`);
    const { clairs: anciens } = await facteurActif(identityId);
    const neufs = genererCodesSecours();
    expect(await mfa.remplacerCodesSecours(identityId, neufs.empreintes)).toBe(true);
    expect(await mfa.consommerCodeSecours(identityId, empreinteCodeSecours(anciens[0]!)!)).toBe(false);
    expect(await mfa.consommerCodeSecours(identityId, neufs.empreintes[0]!)).toBe(true);
    expect(await mfa.remplacerCodesSecours(sansFacteur, neufs.empreintes)).toBe(false);
    expect((await mfa.lire(sansFacteur))!.codesSecoursRestants).toBe(0);
  });

  it('🔴 la réinitialisation par un admin d’espace REFUSE une identité qui a un compte ailleurs', async () => {
    const multi = `mfa.multi.${suffixe}@exemple.fr`;
    const a = await espace('itest-mfa-multi-a', multi);
    const b = await espace('itest-mfa-multi-b', multi);
    expect(b.identityId).toBe(a.identityId);
    await facteurActif(a.identityId);
    expect(await mfa.reinitialiserDansEspace(a.tenantId, a.userId)).toBe('autres_espaces');
    expect((await mfa.lire(a.identityId))!.secret).not.toBeNull();
    // Un compte d'un autre espace ne se désigne pas par l'espace d'ici.
    expect(await mfa.reinitialiserDansEspace(a.tenantId, b.userId)).toBe('not_found');

    // L'exploitation, elle, peut : par l'adresse, quelle que soit sa casse.
    expect(await mfa.reinitialiserParEmail(multi.toUpperCase())).toBe(a.identityId);
    expect(await mfa.lire(a.identityId)).toMatchObject({ secret: null, activeLe: null, dernierPas: null, secretEnAttente: null, codesSecoursRestants: 0 });
    expect(await mfa.reinitialiserParEmail(`personne.${suffixe}@exemple.fr`)).toBeNull();
    expect((await mfa.comptes(a.identityId)).map((c) => c.tenantId).sort()).toEqual([a.tenantId, b.tenantId].sort());
  });

  it('une identité d’un seul espace se réinitialise, et l’obligation suit les comptes admin ACTIFS', async () => {
    const { tenantId, userId, identityId } = await espace('itest-mfa-seul', `mfa.seul.${suffixe}@exemple.fr`);
    await facteurActif(identityId);
    expect(await mfa.reinitialiserDansEspace(tenantId, userId)).toBe('ok');
    expect(await mfa.lire(identityId)).toMatchObject({ secret: null, codesSecoursRestants: 0, obligatoire: true });
    // Un admin RÉVOQUÉ n'oblige plus à rien : il ne peut de toute façon plus se connecter.
    await pool.query('update users set disabled_at = now() where id = $1', [userId]);
    expect((await mfa.lire(identityId))!.obligatoire).toBe(false);
    // Et un identifiant mal formé ne part jamais en base (22P02, donc un 500).
    expect(await mfa.lire('pas-un-uuid')).toBeNull();
    expect(await mfa.lireParCompte('pas-un-uuid')).toBeNull();
    expect(await mfa.reinitialiserDansEspace(tenantId, 'pas-un-uuid')).toBe('not_found');
  });
});
