// tests/api-contacts-v1.test.ts
import { describe, it, expect } from 'vitest';
import {
  creerServiceContactsV1, formaterFicheApi, schemaContactV1, schemaPatchContactV1, schemaRechercheContactV1,
  type ResultatFiche,
} from '../src/api/contacts-v1';
import { joignabiliteRcsConnue, joignabiliteRcsToutesFormes, TTL_MS } from '../src/rcs/reachability';
import type { AuditSink } from '../src/audit/journal';
import type { FicheApiLigne } from '../src/crm/contact-store.pg';
import type { UserFieldDef } from '../src/crm/types';
import { FichesMemoire } from './aide/fiches-memoire';

/**
 * LE SERVICE DES FICHES DE L'API PUBLIQUE (spec du 2026-09-24, § 2), sur un répertoire en mémoire aux règles
 * de la base. Ce qui est éprouvé ici : la résolution multi-clés, l'ordre « champs validés AVANT toute
 * création », le consentement dans les deux sens, et les contrats de lecture.
 */
const T = 't1';
const MAINTENANT = new Date('2026-09-24T12:00:00.000Z');

function monter(opts: { defs?: UserFieldDef[]; max?: number; rcs?: boolean | null } = {}) {
  const repertoire = new FichesMemoire();
  const audits: Array<{ action: string; id: string; detail: unknown }> = [];
  const audit: AuditSink = async (_t, _a, action, cible, detail) => { audits.push({ action, id: cible.id, detail }); };
  const defs = [...(opts.defs ?? [])];
  const creees: string[] = [];
  const rcsDemandes: string[] = [];
  const lectures = { definitions: 0 };
  const service = creerServiceContactsV1({
    contacts: repertoire,
    fields: { list: async () => { lectures.definitions += 1; return defs; }, upsert: async (_t, d) => { creees.push(d.key); } },
    audit,
    joignabiliteRcs: async (_t, e164) => { rcsDemandes.push(e164); return opts.rcs ?? null; },
    maxChampsParEspace: opts.max ?? 0,
    maintenant: () => MAINTENANT,
  });
  return { service, repertoire, audits, creees, rcsDemandes, lectures };
}

function idDe(r: ResultatFiche | undefined): string {
  if (!r || r.status === 'error') throw new Error(`attendu un succès, reçu ${JSON.stringify(r)}`);
  return r.contactId;
}

describe('ecrireFiches : créer ou compléter', () => {
  it('🔴 crée par numéro, puis une écriture par identifiant externe SEUL complète la MÊME fiche', async () => {
    const { service, repertoire } = monter();
    const [r1] = await service.ecrireFiches(T, [{ phone: '+33612345678', externalId: 'crm-7781' }]);
    expect(r1).toMatchObject({ status: 'created' });
    const id = idDe(r1);
    const [r2] = await service.ecrireFiches(T, [{ externalId: 'crm-7781', name: 'Camille Roy', fields: { ville: 'Lyon' }, tags: ['prospect'] }]);
    expect(r2).toEqual({ index: 0, status: 'updated', contactId: id });
    expect(repertoire.fiches.find((f) => f.id === id)).toMatchObject({ profileName: 'Camille Roy', fields: { ville: 'Lyon' }, tags: ['prospect'] });
  });

  it('🔴 un identifiant externe seul et INCONNU : `unknown_contact`, et aucune fiche', async () => {
    const { service, repertoire } = monter();
    const [r] = await service.ecrireFiches(T, [{ externalId: 'crm-7781' }]);
    expect(r).toMatchObject({ status: 'error', code: 'unknown_contact' });
    expect(repertoire.fiches).toHaveLength(0);
  });

  it('un BSUID seul suffit : cette route crée', async () => {
    const { service } = monter();
    expect((await service.ecrireFiches(T, [{ bsuid: 'BSUID-1' }]))[0]).toMatchObject({ status: 'created' });
  });

  it('🔴 deux clés sur deux fiches : `identity_conflict`, et RIEN n’est écrit, pas même le nom', async () => {
    const { service, repertoire } = monter();
    const a = repertoire.ajouter(T, { phoneE164: '+33612345678' });
    repertoire.ajouter(T, { phoneE164: '+33698765432', externalId: 'crm-7781' });
    const [r] = await service.ecrireFiches(T, [{ phone: '+33612345678', externalId: 'crm-7781', name: 'Intrus' }]);
    expect(r).toMatchObject({ status: 'error', code: 'identity_conflict' });
    expect(repertoire.ecritures).toEqual([]);
    expect(a.profileName).toBeNull();
  });

  it('🔴 un champ refusé ne crée PAS de fiche : les champs sont validés avant toute création', async () => {
    const { service, repertoire, creees } = monter({ defs: [{ key: 'prenom', label: 'prenom', type: 'text' } as UserFieldDef], max: 1 });
    const [r] = await service.ecrireFiches(T, [{ phone: '+33612345678', fields: { nouveau: 'x' } }]);
    expect(r).toMatchObject({ status: 'error', code: 'invalid_body' });
    expect(repertoire.fiches).toHaveLength(0);
    expect(creees).toEqual([]);
  });

  it('deux éléments du même numéro dans un lot : UNE seule fiche', async () => {
    const { service, repertoire } = monter();
    const res = await service.ecrireFiches(T, [{ phone: '+33612345678' }, { phone: '06 12 34 56 78', name: 'Marc' }]);
    expect(res.map((r) => r.index)).toEqual([0, 1]);
    expect(new Set(res.map(idDe)).size).toBe(1);
    expect(res.map((r) => r.status).sort()).toEqual(['created', 'updated']);
    expect(repertoire.fiches).toHaveLength(1);
  });

  it('aucune clé : `invalid_recipient` ; numéro illisible : `invalid_phone` ; chaque erreur à SON index', async () => {
    const { service } = monter();
    const res = await service.ecrireFiches(T, [{ name: 'sans clé' }, { phone: '+33612345678' }, { phone: 'n-importe-quoi' }]);
    expect(res.map((r) => (r.status === 'error' ? r.code : r.status))).toEqual(['invalid_recipient', 'created', 'invalid_phone']);
  });

  it('🔴 un élément sans clé ou au numéro illisible ne fait naître AUCUNE définition de champ', async () => {
    // Les clés d'abord, les champs ensuite, comme l'upsert d'avant : une définition est durable et compte
    // dans le plafond de l'espace, un élément refusé ne doit pas en laisser.
    const { service, repertoire, creees } = monter();
    const res = await service.ecrireFiches(T, [{ name: 'x', fields: { nouveau: 'v' } }, { phone: 'n-importe-quoi', fields: { autre: 'v' } }]);
    expect(res.map((r) => (r.status === 'error' ? r.code : r.status))).toEqual(['invalid_recipient', 'invalid_phone']);
    expect(creees).toEqual([]);
    expect(repertoire.fiches).toHaveLength(0);
  });

  it('🔴 le coût d’un élément complet : UNE recherche et UNE écriture, pas une transaction de plusieurs allers-retours', async () => {
    const { service, repertoire } = monter();
    const f = repertoire.ajouter(T, { phoneE164: '+33612345678' });
    await service.ecrireFiches(T, [{ phone: '+33612345678', name: 'Marc', fields: { ville: 'Lyon' }, tags: ['vip'] }]);
    expect(repertoire.appelsChercher).toBe(1);
    expect(repertoire.ecritures).toEqual([`edition:${f.id}`]);
  });

  it('🔴 une fiche PURGÉE entre la résolution et l’écriture n’est pas réécrite : `unknown_contact`', async () => {
    const { service, repertoire } = monter();
    const f = repertoire.ajouter(T, { phoneE164: '+33612345678' });
    const chercher = repertoire.chercherParCles.bind(repertoire);
    // La résolution voit la fiche active, puis une purge passe avant l'écriture.
    repertoire.chercherParCles = async (t, c) => { const r = await chercher(t, c); f.supprimee = true; return r; };
    const [r] = await service.ecrireFiches(T, [{ phone: '+33612345678', name: 'Intrus', fields: { ville: 'Lyon' } }]);
    expect(r).toMatchObject({ status: 'error', code: 'unknown_contact' });
    expect(f.profileName).toBeNull();
    expect(f.fields).toEqual({});
  });

  it('🔴 deux éléments de la MÊME personne dans un lot s’écrivent DANS L’ORDRE : le second retrouve la fiche que le premier a créée', async () => {
    const { service, repertoire } = monter();
    // Même vague, clés différentes mais personne commune (l'identifiant externe) : en parallèle, le second se
    // résolvait avant la création du premier et rendait `unknown_contact`.
    const res = await service.ecrireFiches(T, [{ phone: '+33612345678', externalId: 'crm-7781' }, { externalId: 'crm-7781', name: 'Camille' }]);
    expect(res.map((r) => r.status)).toEqual(['created', 'updated']);
    expect(new Set(res.map(idDe)).size).toBe(1);
    expect(repertoire.fiches).toHaveLength(1);
    expect(repertoire.fiches[0]!.profileName).toBe('Camille');
  });

  it('le lien entre éléments est TRANSITIF, et deux personnes distinctes restent deux fiches', async () => {
    const { service, repertoire } = monter();
    const res = await service.ecrireFiches(T, [
      { phone: '+33612345678', externalId: 'crm-1' },
      { externalId: 'crm-1', bsuid: 'BSUID-1' },
      { bsuid: 'BSUID-1', name: 'Camille' },
      { phone: '+33698765432', name: 'Marc' },
    ]);
    expect(res.map((r) => r.status)).toEqual(['created', 'updated', 'updated', 'created']);
    expect(repertoire.fiches).toHaveLength(2);
    expect(repertoire.fiches[0]).toMatchObject({ externalId: 'crm-1', bsuid: 'BSUID-1', profileName: 'Camille' });
  });
});

describe('ecrireFiches : le consentement', () => {
  it('🔴 `consent: opted_out` : statut, date, et une ligne `contact.optout` (source api)', async () => {
    const { service, repertoire, audits } = monter();
    const id = idDe((await service.ecrireFiches(T, [{ phone: '+33612345678', consent: 'opted_out' }]))[0]);
    expect(repertoire.fiches[0]).toMatchObject({ optInStatus: 'opted_out', optInSource: 'api' });
    expect(repertoire.fiches[0]!.optOutAt).not.toBeNull();
    expect(audits).toEqual([{ action: 'contact.optout', id, detail: { source: 'api', consentSource: 'api' } }]);
  });

  it('🔴 une écriture SANS `consent` ne rétrograde jamais un désabonné', async () => {
    const { service, repertoire, audits } = monter();
    const f = repertoire.ajouter(T, { phoneE164: '+33612345678', optInStatus: 'opted_out', optInSource: 'crm' });
    await service.ecrireFiches(T, [{ phone: '+33612345678', name: 'Marc' }]);
    // La PREUVE que l'élément a été écrit : sans elle, un service qui ne ferait rien laisserait ce test vert,
    // l'état attendu du consentement étant l'état de départ. Et aucune écriture `consentement:` n'est partie.
    expect(f.profileName).toBe('Marc');
    expect(repertoire.ecritures).toEqual([`edition:${f.id}`]);
    expect(f).toMatchObject({ optInStatus: 'opted_out', optInSource: 'crm' });
    expect(audits).toEqual([]);
  });

  it('🔴 un `consent` sur une fiche PURGÉE depuis la résolution : `unknown_contact`, jamais « updated »', async () => {
    const { service, repertoire, audits } = monter();
    const f = repertoire.ajouter(T, { phoneE164: '+33612345678' });
    const chercher = repertoire.chercherParCles.bind(repertoire);
    repertoire.chercherParCles = async (t, c) => { const r = await chercher(t, c); f.supprimee = true; return r; };
    // Des clés et un consentement, rien d'autre : c'est l'écriture du consentement qui trouve la fiche partie.
    const [r] = await service.ecrireFiches(T, [{ phone: '+33612345678', consent: 'opted_out' }]);
    expect(r).toMatchObject({ status: 'error', code: 'unknown_contact' });
    expect(f.optInStatus).toBe('unknown');
    expect(audits).toEqual([]);
  });

  it('⚠️ un `opted_in` d’une AUTRE source sur une fiche déjà `opted_in` ne réécrit rien : la source d’origine est gardée', async () => {
    const { service, repertoire, audits } = monter();
    const f = repertoire.ajouter(T, { phoneE164: '+33612345678', optInStatus: 'opted_in', optInSource: 'crm' });
    expect((await service.ecrireFiches(T, [{ phone: '+33612345678', consent: 'opted_in', consentSource: 'formulaire-site' }]))[0]).toMatchObject({ status: 'updated' });
    expect(await service.modifierFiche(T, f.id, { consent: 'opted_in', consentSource: 'formulaire-site' })).toEqual({ ok: true, contactId: f.id });
    expect(f).toMatchObject({ optInStatus: 'opted_in', optInSource: 'crm' });
    expect(repertoire.ecritures).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('⚠️ un `opted_out` répété garde la date du premier et ne journalise qu’une fois', async () => {
    const { service, repertoire, audits } = monter();
    await service.ecrireFiches(T, [{ phone: '+33612345678', consent: 'opted_out' }]);
    const date = repertoire.fiches[0]!.optOutAt;
    await service.ecrireFiches(T, [{ phone: '+33612345678', consent: 'opted_out' }]);
    expect(repertoire.fiches[0]!.optOutAt).toBe(date);
    expect(audits).toHaveLength(1);
  });

  /**
   * 🔴 UN STOP NE SE LÈVE PAS PAR MACHINE (décision de Julien du 2026-09-24). L'API peut faire passer une fiche
   * de « inconnu » à « opt-in », jamais annuler un désabonnement : une synchronisation qui porte un consentement
   * périmé réabonnerait quelqu'un qui nous a dit stop. Seul un opérateur (la fiche de la console) ou la
   * personne elle-même le peut. Et le refus tombe AVANT toute écriture : ni champ, ni étiquette, ni nom.
   */
  it('🔴 un STOP ne se lève pas par machine : `opted_in` sur une fiche `opted_out` rend `opted_out`, et rien n’est écrit', async () => {
    const { service, repertoire, audits } = monter();
    const f = repertoire.ajouter(T, { phoneE164: '+33612345678', optInStatus: 'opted_out', optInSource: 'stop' });
    const [r] = await service.ecrireFiches(T, [{ phone: '+33612345678', consent: 'opted_in', name: 'Marc', tags: ['vip'] }]);
    expect(r).toMatchObject({ status: 'error', code: 'opted_out' });
    expect(f).toMatchObject({ optInStatus: 'opted_out', optInSource: 'stop', profileName: null, tags: [] });
    expect(repertoire.ecritures).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('🔴 même règle sur PATCH : `opted_out`, et rien n’est écrit', async () => {
    const { service, repertoire, audits } = monter();
    const f = repertoire.ajouter(T, { phoneE164: '+33612345678', optInStatus: 'opted_out', optInSource: 'stop' });
    expect(await service.modifierFiche(T, f.id, { consent: 'opted_in', name: 'Marc' })).toMatchObject({ ok: false, code: 'opted_out' });
    expect(f).toMatchObject({ optInStatus: 'opted_out', profileName: null });
    expect(repertoire.ecritures).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('⚠️ un STOP posé ENTRE la vérification et l’écriture du consentement : `opted_out` aussi, la garde du dépôt tient la course', async () => {
    const { service, repertoire, audits } = monter();
    const f = repertoire.ajouter(T, { phoneE164: '+33612345678' });
    const lire = repertoire.lireFicheApi.bind(repertoire);
    // La vérification lit « inconnu », puis le STOP arrive avant l'écriture du consentement.
    repertoire.lireFicheApi = async (t, id) => { const l = await lire(t, id); f.optInStatus = 'opted_out'; return l; };
    const [r] = await service.ecrireFiches(T, [{ phone: '+33612345678', consent: 'opted_in' }]);
    expect(r).toMatchObject({ status: 'error', code: 'opted_out' });
    expect(f.optInStatus).toBe('opted_out');
    expect(audits).toEqual([]);
  });

  it('`consentSource` est la source écrite', async () => {
    const { service, repertoire } = monter();
    await service.ecrireFiches(T, [{ phone: '+33612345678', consent: 'opted_in', consentSource: 'formulaire-site' }]);
    expect(repertoire.fiches[0]).toMatchObject({ optInStatus: 'opted_in', optInSource: 'formulaire-site' });
  });
});

describe('lire et chercher', () => {
  const LIGNE: FicheApiLigne = {
    id: '00000000-0000-4000-8000-000000000009', externalId: 'crm-7781', phoneE164: '+33612345678', bsuid: null,
    profileName: 'Camille Roy', fields: { ville: 'Lyon' }, tags: ['prospect'], optInStatus: 'opted_in',
    optInSource: 'formulaire-site', optOutAt: null, rcsOptoutAt: null, blockedAt: null,
    whatsappJoignable: true, whatsappJoignableLe: '2026-09-20T10:00:00.000Z', createdAt: '2026-09-01T10:00:00.000Z',
  };

  it('🔴 le contrat de lecture du § 2, champ pour champ', () => {
    expect(formaterFicheApi(LIGNE, null, MAINTENANT)).toEqual({
      contactId: LIGNE.id, externalId: 'crm-7781', phone: '+33612345678', bsuid: null, name: 'Camille Roy',
      fields: { ville: 'Lyon' }, tags: ['prospect'],
      consent: { status: 'opted_in', source: 'formulaire-site', optedOutAt: null },
      rcsOptedOutAt: null, blocked: false, reachability: { whatsapp: true, rcs: null },
      createdAt: '2026-09-01T10:00:00.000Z',
    });
  });

  it('⚠️ une mesure WhatsApp PÉRIMÉE redevient inconnue (`null`, jamais `false`) ; un statut illisible vaut `unknown`', () => {
    const f = formaterFicheApi({ ...LIGNE, whatsappJoignable: false, whatsappJoignableLe: '2026-05-01T10:00:00.000Z', optInStatus: 'bizarre', blockedAt: '2026-09-02T00:00:00.000Z' }, false, MAINTENANT);
    expect(f.reachability).toEqual({ whatsapp: null, rcs: false });
    expect(f.consent.status).toBe('unknown');
    expect(f.blocked).toBe(true);
  });

  it('la joignabilité RCS connue : une entrée périmée ne dit plus rien', () => {
    const now = MAINTENANT.getTime();
    expect(joignabiliteRcsConnue(null, now)).toBeNull();
    expect(joignabiliteRcsConnue({ reachable: false, checkedAt: now - 1000 }, now)).toBe(false);
    expect(joignabiliteRcsConnue({ reachable: true, checkedAt: now - TTL_MS - 1 }, now)).toBeNull();
  });

  it('🔴 la joignabilité RCS se lit sous les DEUX formes de clé du cache, la plus récente gagnant', async () => {
    const now = MAINTENANT.getTime();
    const cache = (entrees: Record<string, { reachable: boolean; checkedAt: number }>) => ({
      get: async (_agent: string, cle: string) => entrees[cle] ?? null,
    });
    // Écrite en chiffres seuls par un scénario ou l'Inbox, relue depuis la forme `+33…` de la fiche.
    expect(await joignabiliteRcsToutesFormes(cache({ '33612345678': { reachable: true, checkedAt: now - 1000 } }), 'a1', '+33612345678', now)).toBe(true);
    expect(await joignabiliteRcsToutesFormes(cache({ '+33612345678': { reachable: false, checkedAt: now - 1000 } }), 'a1', '+33612345678', now)).toBe(false);
    const deux = cache({
      '+33612345678': { reachable: false, checkedAt: now - 5000 },
      '33612345678': { reachable: true, checkedAt: now - 1000 },
    });
    expect(await joignabiliteRcsToutesFormes(deux, 'a1', '+33612345678', now)).toBe(true);
    expect(await joignabiliteRcsToutesFormes(cache({}), 'a1', '+33612345678', now)).toBeNull();
  });

  it('lireFiche : identifiant mal formé ou fiche supprimée, `null` ; sans numéro, le RCS n’est même pas demandé', async () => {
    const { service, repertoire, rcsDemandes } = monter({ rcs: true });
    expect(await service.lireFiche(T, 'c1')).toBeNull();
    const supprimee = repertoire.ajouter(T, { phoneE164: '+33612345678', supprimee: true });
    expect(await service.lireFiche(T, supprimee.id)).toBeNull();
    const sansNumero = repertoire.ajouter(T, { bsuid: 'BSUID-1' });
    expect((await service.lireFiche(T, sansNumero.id))?.reachability).toEqual({ whatsapp: null, rcs: null });
    expect(rcsDemandes).toEqual([]);
    const avecNumero = repertoire.ajouter(T, { phoneE164: '+33698765432' });
    expect((await service.lireFiche(T, avecNumero.id))?.reachability.rcs).toBe(true);
    expect(rcsDemandes).toEqual(['+33698765432']);
  });

  it('chercherFiche : par numéro (même écrit en national), par identifiant externe ; inconnu : `null`', async () => {
    const { service, repertoire } = monter();
    const f = repertoire.ajouter(T, { phoneE164: '+33612345678', externalId: 'crm-7781' });
    expect(await service.chercherFiche(T, { phone: '06 12 34 56 78' })).toMatchObject({ ok: true, fiche: { contactId: f.id } });
    expect(await service.chercherFiche(T, { externalId: 'crm-7781' })).toMatchObject({ ok: true, fiche: { contactId: f.id } });
    expect(await service.chercherFiche(T, { bsuid: 'inconnu' })).toEqual({ ok: true, fiche: null });
    expect(await service.chercherFiche(T, { phone: 'n-importe-quoi' })).toMatchObject({ ok: false, code: 'invalid_phone' });
  });

  it('la recherche exige EXACTEMENT une clé, et n’accepte pas `contactId` (c’est `GET`)', () => {
    expect(schemaRechercheContactV1.safeParse({ phone: '+33612345678' }).success).toBe(true);
    expect(schemaRechercheContactV1.safeParse({ phone: '+33612345678', externalId: 'crm-7781' }).success).toBe(false);
    expect(schemaRechercheContactV1.safeParse({}).success).toBe(false);
    expect(schemaRechercheContactV1.safeParse({ contactId: '00000000-0000-4000-8000-000000000001' }).success).toBe(false);
  });
});

describe('modifierFiche', () => {
  it('🔴 `fields` : `null` VIDE le champ, les autres se fusionnent', async () => {
    const { service, repertoire } = monter();
    const f = repertoire.ajouter(T, { phoneE164: '+33612345678', fields: { ville: 'Lyon', age: '42' } });
    expect(await service.modifierFiche(T, f.id, { fields: { ville: null, prenom: 'Camille' } })).toEqual({ ok: true, contactId: f.id });
    expect(f.fields).toEqual({ age: '42', prenom: 'Camille' });
  });

  it('🔴 `externalId` se pose et se remplace ; porté ailleurs : `identity_conflict`, et le reste n’est pas écrit', async () => {
    const { service, repertoire } = monter();
    const a = repertoire.ajouter(T, { phoneE164: '+33612345678', externalId: 'crm-1' });
    repertoire.ajouter(T, { phoneE164: '+33698765432', externalId: 'crm-2' });
    expect(await service.modifierFiche(T, a.id, { externalId: 'crm-3' })).toEqual({ ok: true, contactId: a.id });
    expect(a.externalId).toBe('crm-3');
    expect(await service.modifierFiche(T, a.id, { externalId: 'crm-2', name: 'Intrus' })).toMatchObject({ ok: false, code: 'identity_conflict' });
    expect(a.externalId).toBe('crm-3');
    expect(a.profileName).toBeNull();
  });

  it('🔴 un champ refusé n’écrit RIEN, pas même l’identifiant externe demandé dans le même appel', async () => {
    const { service, repertoire } = monter();
    const a = repertoire.ajouter(T, { phoneE164: '+33612345678', externalId: 'crm-1' });
    expect(await service.modifierFiche(T, a.id, { externalId: 'crm-9', fields: { fld_inconnu: 'x' } })).toMatchObject({ ok: false, code: 'invalid_body' });
    expect(a.externalId).toBe('crm-1');
    expect(repertoire.ecritures).toEqual([]);
  });

  it('étiquettes ajoutées et retirées, nom vidé par `null`, consentement', async () => {
    const { service, repertoire, audits } = monter();
    const f = repertoire.ajouter(T, { phoneE164: '+33612345678', profileName: 'Marc', tags: ['a', 'b'] });
    await service.modifierFiche(T, f.id, { addTags: ['c'], removeTags: ['a'], name: null, consent: 'opted_out' });
    expect(f).toMatchObject({ tags: ['b', 'c'], profileName: null, optInStatus: 'opted_out' });
    expect(audits.map((a) => a.action)).toEqual(['contact.optout']);
  });

  it('🔴 `consent` seul sur une fiche PURGÉE depuis la résolution : `unknown_contact`, jamais `ok`', async () => {
    const { service, repertoire, audits } = monter();
    const f = repertoire.ajouter(T, { phoneE164: '+33612345678' });
    const chercher = repertoire.chercherParCles.bind(repertoire);
    repertoire.chercherParCles = async (t, c) => { const r = await chercher(t, c); f.supprimee = true; return r; };
    expect(await service.modifierFiche(T, f.id, { consent: 'opted_out' })).toMatchObject({ ok: false, code: 'unknown_contact' });
    expect(f.optInStatus).toBe('unknown');
    expect(audits).toEqual([]);
  });

  it('les définitions de champs sont lues UNE fois pour tous les champs à vider, pas une fois par champ', async () => {
    const { service, repertoire, lectures } = monter({ defs: ['a', 'b', 'c'].map((k) => ({ key: k, label: k, type: 'text' }) as UserFieldDef) });
    const f = repertoire.ajouter(T, { phoneE164: '+33612345678', fields: { a: '1', b: '2', c: '3' } });
    expect(await service.modifierFiche(T, f.id, { fields: { a: null, b: null, c: null } })).toEqual({ ok: true, contactId: f.id });
    expect(f.fields).toEqual({});
    expect(lectures.definitions).toBe(1);
  });

  it('rien à modifier : `invalid_body` ; fiche inconnue ou mal désignée : `unknown_contact`', async () => {
    const { service, repertoire } = monter();
    const f = repertoire.ajouter(T, { phoneE164: '+33612345678' });
    expect(await service.modifierFiche(T, f.id, {})).toMatchObject({ ok: false, code: 'invalid_body' });
    expect(await service.modifierFiche(T, '00000000-0000-4000-8000-999999999999', { name: 'x' })).toMatchObject({ ok: false, code: 'unknown_contact' });
    expect(await service.modifierFiche(T, 'c1', { name: 'x' })).toMatchObject({ ok: false, code: 'unknown_contact' });
  });

  it('le numéro et le BSUID ne se modifient pas ici', () => {
    expect(schemaPatchContactV1.safeParse({ phone: '+33612345678' }).success).toBe(false);
    expect(schemaPatchContactV1.safeParse({ bsuid: 'B' }).success).toBe(false);
  });
});

describe('schemaContactV1', () => {
  it('🔴 `optIn` est refusé : il est remplacé par `consent`', () => {
    expect(schemaContactV1.safeParse({ phone: '+33612345678', optIn: true }).success).toBe(false);
    expect(schemaContactV1.safeParse({ phone: '+33612345678', consent: 'opted_in', consentSource: 'formulaire-site' }).success).toBe(true);
  });

  it('🔴 une chaîne vide ou blanche vaut ABSENCE pour `name`, `consent` et `consentSource`, comme pour les clés', () => {
    // Un outil qui remplit son corps avec les variables d'un profil envoie `""` pour une variable absente :
    // refuser l'élément entier pour ça serait refuser précisément le cas d'usage de la règle.
    const r = schemaContactV1.safeParse({ phone: '+33612345678', name: '', consent: '', consentSource: ' ' });
    expect(r.success).toBe(true);
    expect(r.success && [r.data.name, r.data.consent, r.data.consentSource]).toEqual([undefined, undefined, undefined]);
    const p = schemaPatchContactV1.safeParse({ name: ' ', consent: '', consentSource: '' });
    expect(p.success && [p.data.name, p.data.consent, p.data.consentSource]).toEqual([undefined, undefined, undefined]);
    // `null` reste le geste explicite qui VIDE le nom.
    const vider = schemaPatchContactV1.safeParse({ name: null });
    expect(vider.success && vider.data.name).toBeNull();
    // Une valeur fausse reste refusée : l'absence ne couvre que le vide.
    expect(schemaContactV1.safeParse({ phone: '+33612345678', consent: 'oui' }).success).toBe(false);
  });
});
