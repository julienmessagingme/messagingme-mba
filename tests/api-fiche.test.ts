// tests/api-fiche.test.ts
import { describe, it, expect } from 'vitest';
import { resoudreFiche, schemaClesFiche, normaliserCles } from '../src/api/fiche';
import { FichesMemoire } from './aide/fiches-memoire';

/**
 * TROUVER LA FICHE D'UNE PERSONNE (spec de l'API publique, § 1 et § 13 « Identité »).
 *
 * 🔴 TOUTES LES CLÉS DONNÉES DOIVENT DÉSIGNER LA MÊME FICHE, sinon rien n'est écrit. Et une clé que la
 * fiche ne porte pas encore lui est RATTACHÉE : un outil envoie naturellement le numéro ET son propre
 * identifiant dans le même corps.
 */
const T = 't1';

describe('resoudreFiche : retrouver', () => {
  it('🔴 chaque clé, seule ou avec les autres, retrouve la MÊME fiche, sans rien écrire', async () => {
    const r = new FichesMemoire();
    const f = r.ajouter(T, { phoneE164: '+33612345678', externalId: 'crm-7781', bsuid: 'BSUID-1' });
    const cas = [
      { contactId: f.id }, { externalId: 'crm-7781' }, { phone: '+33612345678' }, { phone: '06 12 34 56 78' },
      { bsuid: 'BSUID-1' }, { contactId: f.id, externalId: 'crm-7781', phone: '0612345678', bsuid: 'BSUID-1' },
    ];
    for (const cles of cas) {
      expect(await resoudreFiche(r, T, cles, { creer: 'jamais' }), JSON.stringify(cles)).toEqual({ ok: true, contactId: f.id, cree: false });
    }
    expect(r.ecritures).toEqual([]);
  });

  it('une fiche à numéro ET BSUID se retrouve par son BSUID, et c’est la FICHE qui est rendue', async () => {
    const r = new FichesMemoire();
    const f = r.ajouter(T, { phoneE164: '+33612345678', bsuid: 'BSUID-1' });
    // La résolution rend une FICHE, jamais une adresse : l'adresse se calcule sur la fiche, là où l'on envoie.
    expect(await resoudreFiche(r, T, { bsuid: 'BSUID-1' }, { creer: 'jamais' })).toEqual({ ok: true, contactId: f.id, cree: false });
  });

  it('🔴 un `contactId` écrit en MAJUSCULES retrouve la fiche, et l’identifiant rendu est celui de la base', async () => {
    const r = new FichesMemoire();
    const f = r.ajouter(T, { id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', phoneE164: '+33612345678' });
    expect(await resoudreFiche(r, T, { contactId: f.id.toUpperCase() }, { creer: 'jamais' })).toEqual({ ok: true, contactId: f.id, cree: false });
    expect(await resoudreFiche(r, T, { contactId: f.id.toUpperCase(), phone: '+33612345678' }, { creer: 'jamais' })).toEqual({ ok: true, contactId: f.id, cree: false });
  });

  it('une fiche d’un autre espace n’existe pas', async () => {
    const r = new FichesMemoire();
    r.ajouter('t2', { externalId: 'crm-7781', phoneE164: '+33612345678' });
    expect(await resoudreFiche(r, T, { externalId: 'crm-7781' }, { creer: 'jamais' })).toEqual({ ok: false, code: 'unknown_contact' });
  });
});

describe('resoudreFiche : les refus', () => {
  it('aucune clé : `invalid_recipient` ; un numéro illisible : `invalid_phone`', async () => {
    const r = new FichesMemoire();
    expect(await resoudreFiche(r, T, {}, { creer: 'phone_ou_bsuid' })).toEqual({ ok: false, code: 'invalid_recipient' });
    expect(await resoudreFiche(r, T, { phone: '  ', externalId: '' }, { creer: 'phone_ou_bsuid' })).toEqual({ ok: false, code: 'invalid_recipient' });
    expect(await resoudreFiche(r, T, { phone: 'pas-un-numero' }, { creer: 'phone_ou_bsuid' })).toEqual({ ok: false, code: 'invalid_phone' });
  });

  it('un `contactId` mal formé ne va pas jusqu’à la base : `unknown_contact`', async () => {
    const r = new FichesMemoire();
    expect(await resoudreFiche(r, T, { contactId: 'c1' }, { creer: 'jamais' })).toEqual({ ok: false, code: 'unknown_contact' });
    expect(r.appelsChercher).toBe(0);
  });

  it('🔴 deux clés sur deux fiches : `identity_conflict`, et RIEN n’est écrit', async () => {
    const r = new FichesMemoire();
    r.ajouter(T, { phoneE164: '+33612345678' });
    r.ajouter(T, { phoneE164: '+33698765432', externalId: 'crm-7781' });
    expect(await resoudreFiche(r, T, { phone: '+33612345678', externalId: 'crm-7781' }, { creer: 'phone_ou_bsuid' })).toEqual({ ok: false, code: 'identity_conflict' });
    expect(r.ecritures).toEqual([]);
  });

  it('🔴 une clé que la fiche porte déjà AUTREMENT : `identity_conflict`, on ne remplace pas', async () => {
    const r = new FichesMemoire();
    const f = r.ajouter(T, { phoneE164: '+33612345678', externalId: 'crm-ancien' });
    expect(await resoudreFiche(r, T, { phone: '+33612345678', externalId: 'crm-7781' }, { creer: 'phone_ou_bsuid' })).toEqual({ ok: false, code: 'identity_conflict' });
    expect(f.externalId).toBe('crm-ancien');
    expect(r.ecritures).toEqual([]);
  });

  it('🔴 un `contactId` inconnu ne crée JAMAIS rien, même accompagné d’un numéro', async () => {
    const r = new FichesMemoire();
    expect(await resoudreFiche(r, T, { contactId: '00000000-0000-4000-8000-999999999999', phone: '+33612345678' }, { creer: 'phone_ou_bsuid' }))
      .toEqual({ ok: false, code: 'unknown_contact' });
    expect(r.fiches).toHaveLength(0);
  });
});

describe('resoudreFiche : rattacher et créer', () => {
  it('🔴 une clé neuve est RATTACHÉE à la fiche trouvée', async () => {
    const r = new FichesMemoire();
    const f = r.ajouter(T, { phoneE164: '+33612345678' });
    expect(await resoudreFiche(r, T, { phone: '+33612345678', externalId: 'crm-7781' }, { creer: 'jamais' })).toEqual({ ok: true, contactId: f.id, cree: false });
    expect(f.externalId).toBe('crm-7781');
    expect(await resoudreFiche(r, T, { externalId: 'crm-7781' }, { creer: 'jamais' })).toEqual({ ok: true, contactId: f.id, cree: false });
  });

  it('création selon le mode : `jamais` ne crée pas, `phone` exige un numéro, `phone_ou_bsuid` accepte un BSUID', async () => {
    const r = new FichesMemoire();
    expect(await resoudreFiche(r, T, { phone: '+33612345678' }, { creer: 'jamais' })).toEqual({ ok: false, code: 'unknown_contact' });
    expect(await resoudreFiche(r, T, { bsuid: 'BSUID-1' }, { creer: 'phone' })).toEqual({ ok: false, code: 'unknown_contact' });
    expect(await resoudreFiche(r, T, { externalId: 'crm-7781' }, { creer: 'phone_ou_bsuid' })).toEqual({ ok: false, code: 'unknown_contact' });
    expect(r.fiches).toHaveLength(0);

    const parNumero = await resoudreFiche(r, T, { phone: '06 12 34 56 78', externalId: 'crm-7781' }, { creer: 'phone' });
    expect(parNumero).toMatchObject({ ok: true, cree: true });
    expect(r.fiches[0]).toMatchObject({ phoneE164: '+33612345678', externalId: 'crm-7781' });
    expect(await resoudreFiche(r, T, { bsuid: 'BSUID-2' }, { creer: 'phone_ou_bsuid' })).toMatchObject({ ok: true, cree: true });
  });

  it('🔴 une course sur l’identifiant externe finit en `identity_conflict`, jamais en seconde fiche', async () => {
    const r = new FichesMemoire();
    const autre = r.ajouter(T, { phoneE164: '+33698765432' });
    const creer = r.creerFicheApi.bind(r);
    let premier = true;
    // Entre la lecture et la création, une autre écriture pose le même identifiant sur une autre fiche.
    r.creerFicheApi = async (t, c) => {
      if (premier) { premier = false; autre.externalId = 'crm-course'; }
      return creer(t, c);
    };
    expect(await resoudreFiche(r, T, { phone: '+33612345678', externalId: 'crm-course' }, { creer: 'phone_ou_bsuid' })).toEqual({ ok: false, code: 'identity_conflict' });
    expect(r.fiches).toHaveLength(1);
  });

  it('le numéro d’une fiche supprimée la ressuscite (comportement de l’upsert d’avant, gardé)', async () => {
    const r = new FichesMemoire();
    const f = r.ajouter(T, { phoneE164: '+33612345678', supprimee: true });
    expect(await resoudreFiche(r, T, { phone: '+33612345678' }, { creer: 'phone_ou_bsuid' })).toEqual({ ok: true, contactId: f.id, cree: false });
    expect(f.supprimee).toBe(false);
  });

  it('🔴 fiche supprimée, même numéro, AUTRE BSUID ou AUTRE identifiant externe : `identity_conflict`, et elle RESTE supprimée', async () => {
    const r = new FichesMemoire();
    const parBsuid = r.ajouter(T, { phoneE164: '+33612345678', bsuid: 'BSUID-ancien', supprimee: true });
    expect(await resoudreFiche(r, T, { phone: '+33612345678', bsuid: 'BSUID-neuf' }, { creer: 'phone_ou_bsuid' })).toEqual({ ok: false, code: 'identity_conflict' });
    expect(parBsuid).toMatchObject({ supprimee: true, bsuid: 'BSUID-ancien' });

    const parExterne = r.ajouter(T, { phoneE164: '+33698765432', externalId: 'crm-ancien', supprimee: true });
    expect(await resoudreFiche(r, T, { phone: '+33698765432', externalId: 'crm-7781', bsuid: 'BSUID-2' }, { creer: 'phone_ou_bsuid' })).toEqual({ ok: false, code: 'identity_conflict' });
    expect(parExterne).toMatchObject({ supprimee: true, externalId: 'crm-ancien', bsuid: null });
    expect(r.ecritures).toEqual([]);
  });

  /**
   * 🔴 L'INDEX DE L'IDENTIFIANT EXTERNE NE COMPTE QUE LES FICHES ACTIVES (migration 0172, revue finale du
   * 2026-09-24). Sinon une fiche supprimée, invisible à toute lecture, bloquerait son identifiant pour toujours.
   */
  it('🔴 une fiche SUPPRIMÉE ne retient plus son identifiant externe : une autre fiche peut le prendre', async () => {
    const r = new FichesMemoire();
    r.ajouter(T, { phoneE164: '+33612345678', externalId: 'crm-7781', supprimee: true });
    expect(await resoudreFiche(r, T, { phone: '+33698765432', externalId: 'crm-7781' }, { creer: 'phone_ou_bsuid' })).toMatchObject({ ok: true, cree: true });
    expect(r.fiches.filter((f) => f.externalId === 'crm-7781' && !f.supprimee)).toHaveLength(1);
  });

  it('⚠️ ressusciter une fiche supprimée dont l’identifiant externe a été repris : `identity_conflict`, et elle reste supprimée', async () => {
    const r = new FichesMemoire();
    const ancienne = r.ajouter(T, { phoneE164: '+33612345678', externalId: 'crm-7781', supprimee: true });
    r.ajouter(T, { phoneE164: '+33698765432', externalId: 'crm-7781' });
    expect(await resoudreFiche(r, T, { phone: '+33612345678' }, { creer: 'phone_ou_bsuid' })).toEqual({ ok: false, code: 'identity_conflict' });
    expect(ancienne.supprimee).toBe(true);
  });

  it('🔴 une course au rattachement est TOUT OU RIEN : une clé prise entre-temps, et aucune autre n’est posée', async () => {
    const r = new FichesMemoire();
    const f = r.ajouter(T, { phoneE164: '+33612345678' });
    const rattacher = r.rattacherCles.bind(r);
    // Entre la lecture et le rattachement, une autre écriture pose un AUTRE identifiant externe sur la fiche.
    r.rattacherCles = async (t, id, c) => { f.externalId = 'crm-autre'; return rattacher(t, id, c); };
    expect(await resoudreFiche(r, T, { phone: '+33612345678', externalId: 'crm-7781', bsuid: 'BSUID-1' }, { creer: 'jamais' })).toEqual({ ok: false, code: 'identity_conflict' });
    expect(f.bsuid).toBeNull();
    expect(r.ecritures).toEqual([]);
  });
});

describe('schemaClesFiche et normaliserCles', () => {
  it('une chaîne vide ou blanche vaut ABSENCE, une valeur est rognée', () => {
    const r = schemaClesFiche.safeParse({ phone: '', externalId: '  crm-7781  ', bsuid: '   ' });
    expect(r.success && r.data).toEqual({ externalId: 'crm-7781' });
  });

  it('les bornes : identifiant externe de 512 caractères au plus, `contactId` au format UUID', () => {
    expect(schemaClesFiche.safeParse({ externalId: 'x'.repeat(512) }).success).toBe(true);
    expect(schemaClesFiche.safeParse({ externalId: 'x'.repeat(513) }).success).toBe(false);
    expect(schemaClesFiche.safeParse({ contactId: 'c1' }).success).toBe(false);
    expect(schemaClesFiche.safeParse({ bsuid: 'b'.repeat(201) }).success).toBe(false);
  });

  it('le numéro se normalise en E.164, la France par défaut', () => {
    expect(normaliserCles({ phone: '06 12 34 56 78' })).toEqual({ ok: true, cles: { phoneE164: '+33612345678' } });
  });
});
