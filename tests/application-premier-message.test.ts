import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  enfilerPremierMessage, enfileurPremier, traiterPremierMessage, FILE_PREMIER_MESSAGE, ORIGINES_PREMIER, STATUTS_PREMIER, GEL_MS, REESSAI_MS,
  PEREMPTION_MS,
  type DemandePremierMessage, type DepsJobPremier, type DepsPremierMessage, type IssueJobPremier, type NouveauPremier,
  type OriginePremier, type PremierMessage, type PremiersMessages, type RefusPremier,
} from '../src/application/premier-message';
import { avisDeGel } from '../src/application/avis';
import type { ClientApplication, Resultat } from '../src/application/client';
import type { CompteApplication, StatutCompte } from '../src/application/comptes';
import type { Verification } from '../src/application/interne';
import type { ContactEnvoi } from '../src/campaign/build';
import type { ResolutionFiche } from '../src/api/fiche';
import type { IssueConsentement } from '../src/api/consentement';
import type { Emission } from '../src/emails-produit/emission';
import { jamaisBloque, jamaisDesabonne, toujoursDesabonne } from './consentement';

/**
 * ÉCRIRE EN PREMIER PAR LA FILIÈRE APPLICATION (plan 2026-10-23, tâche 2) : la porte et son job, sur des faux. Ce que la
 * base fait vraiment (la clé unique, le créneau sous verrou, les CHECK) : `tests/integration/application-premier-
 * message.integration.test.ts`, en CI.
 */
const T = 'bbbbbbbb-0000-4000-8000-000000000002';
const T2 = 'bbbbbbbb-0000-4000-8000-000000000003';
const COMPTE = 'aaaaaaaa-0000-4000-8000-000000000001';
const FICHE = 'cccccccc-0000-4000-8000-000000000001';
const MAINTENANT = new Date('2026-10-23T10:00:00Z');

const compte = (statut: StatutCompte, tenantId = T): CompteApplication => ({
  id: COMPTE, tenantId, numero: '447700900000', jid: null, statut, fourniId: null,
  relieLe: new Date('2026-10-01T10:00:00Z'), dernierMessageLe: null, statutChangeLe: new Date(0),
});

/** La file en mémoire, avec le créneau de la vraie : 30 s après le dernier prévu de l'espace, plus l'aléa. */
function fileEnMemoire(maintenant: () => Date = () => MAINTENANT) {
  const lignes = new Map<string, PremierMessage>();
  const gels = new Map<string, Date>();
  let n = 0;
  const store: PremiersMessages & { lignes: Map<string, PremierMessage>; gels: Map<string, Date> } = {
    lignes, gels,
    async existant(t, cle) { return [...lignes.values()].find((l) => l.tenantId === t && l.cle === cle) ?? null; },
    async inserer(m: NouveauPremier, aleatoire: number) {
      const deja = await store.existant(m.tenantId, m.cle);
      if (deja) return { ligne: deja, cree: false };
      const dernier = Math.max(maintenant().getTime(), ...[...lignes.values()].filter((l) => l.tenantId === m.tenantId).map((l) => l.prevuLe.getTime()));
      n += 1;
      const ligne: PremierMessage = {
        ...m, id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, statut: 'en_file', issue: null,
        prevuLe: new Date(dernier + 30_000 + aleatoire * 30_000), essais: 0, messageId: null,
      };
      lignes.set(ligne.id, ligne);
      return { ligne, cree: true };
    },
    async reclamer(id) {
      const l = lignes.get(id);
      if (l?.statut !== 'en_file') return null;
      const prise = { ...l, statut: 'envoi' as const, essais: l.essais + 1 };
      lignes.set(id, prise);
      return prise;
    },
    async remettreEnFile(id, prevuLe) {
      const l = lignes.get(id);
      if (l?.statut === 'envoi') lignes.set(id, { ...l, statut: 'en_file', prevuLe });
    },
    async terminer(id, statut, issue, messageId) {
      const l = lignes.get(id);
      if (l?.statut === 'envoi') lignes.set(id, { ...l, statut, issue, messageId });
    },
    async geleJusqua(compteId) { return gels.get(compteId) ?? null; },
    async geler(compteId, jusqua) {
      const g = gels.get(compteId);
      if (g && g.getTime() > maintenant().getTime()) return false;
      gels.set(compteId, jusqua);
      return true;
    },
    async purgerTermines() { return 0; },
  };
  return store;
}

const demande = (o: Partial<DemandePremierMessage> = {}): DemandePremierMessage => ({
  tenantId: T, cle: 'shopify:boutique:orders/paid:1', telephone: '33612345678', texte: 'Merci pour votre commande',
  origine: 'shopify_commande', reference: 'orders/paid:1', consentement: { mode: 'marchand', source: 'shopify' }, ...o,
});

interface Reglages {
  filiere?: 'api' | 'application' | null;
  statut?: StatutCompte | null;
  gelJusqua?: Date | null;
  fiche?: ResolutionFiche;
  consentement?: IssueConsentement;
  optIn?: ContactEnvoi['optInStatus'] | null;
  desabonne?: boolean;
  bloque?: boolean;
  quotaOk?: boolean;
}

/** La porte montée sur des faux ; chaque geste est noté, dans l'ordre. */
function porte(r: Reglages = {}) {
  const gestes: string[] = [];
  const enfiles: Array<{ tenantId: string; id: string; startAfter: Date }> = [];
  const file = fileEnMemoire();
  if (r.gelJusqua) file.gels.set(COMPTE, r.gelJusqua);
  const statut = r.statut === undefined ? 'relie' : r.statut;
  const deps: DepsPremierMessage = {
    premiers: file,
    comptes: {
      filiereDe: async () => (r.filiere === undefined ? 'application' : r.filiere),
      parEspace: async () => (statut ? compte(statut) : null),
    },
    fiches: {
      resoudreFiche: async (_t, cles, o) => { gestes.push(`fiche:${cles.phone}:${o.creer}`); return r.fiche ?? { ok: true, contactId: FICHE, cree: true }; },
      appliquerConsentement: async (_t, id, c, source) => { gestes.push(`consentement:${id}:${c}:${source}`); return r.consentement ?? 'change'; },
      listContactsPourEnvoiApi: async (_t, ids) => {
        gestes.push(`lecture:${ids.join(',')}`);
        return r.optIn === null ? [] : [{ id: FICHE, phone_e164: '+33612345678', optInStatus: r.optIn ?? 'unknown', bloque: false, rcsDesabonne: false }];
      },
    },
    contacts: {
      estDesabonneParWaId: async (_t, waId) => { gestes.push(`stop:${waId}`); return r.desabonne === true; },
      machineSeTaitParWaId: async (_t, waId) => { gestes.push(`tait:${waId}`); return r.desabonne === true || r.bloque === true; },
    },
    quota: { consommer: async (_t, n) => { gestes.push(`quota:${n}`); return r.quotaOk === false ? { ok: false, max: 1000 } : { ok: true }; } },
    enfiler: async (tenantId, id, startAfter) => { enfiles.push({ tenantId, id, startAfter }); },
    maintenant: () => MAINTENANT,
    aleatoire: () => 0.5,
  };
  return { deps, gestes, enfiles, file };
}

describe('la porte « écrire en premier »', () => {
  it('un message accepté prend un créneau entre 30 et 60 s, est compté une fois, et son job part à ce créneau', async () => {
    const p = porte();
    const r = await enfilerPremierMessage(p.deps, demande());
    expect(r).toMatchObject({ ok: true, dejaEnFile: false });
    if (!r.ok) return;
    expect(r.prevuLe.getTime() - MAINTENANT.getTime()).toBe(45_000);
    expect(p.enfiles).toEqual([{ tenantId: T, id: r.id, startAfter: r.prevuLe }]);
    expect(p.gestes.filter((g) => g.startsWith('quota'))).toEqual(['quota:1']);
    const ligne = p.file.lignes.get(r.id)!;
    expect(ligne).toMatchObject({ waId: '33612345678', texte: 'Merci pour votre commande', origine: 'shopify_commande', reference: 'orders/paid:1', statut: 'en_file' });
  });

  it('🔴 un rejeu de la même clé ne crée pas un second message', async () => {
    const p = porte();
    const premier = await enfilerPremierMessage(p.deps, demande());
    const rejeu = await enfilerPremierMessage(p.deps, demande({ texte: 'autre texte' }));
    expect(rejeu).toEqual({ ok: true, id: (premier as { id: string }).id, prevuLe: (premier as { prevuLe: Date }).prevuLe, dejaEnFile: true });
    expect(p.file.lignes.size).toBe(1);
    // Ni une seconde unité du mois, ni une seconde fiche, ni un second consentement : la clé est lue avant tout.
    expect(p.gestes.filter((g) => g.startsWith('quota'))).toEqual(['quota:1']);
    expect(p.gestes.filter((g) => g.startsWith('fiche'))).toHaveLength(1);
    // Encore en file : son job est enfilé de nouveau à son heure (le rattrapage d'un enfilement perdu).
    expect(p.enfiles.map((e) => e.id)).toEqual([rejeu.ok && rejeu.id, rejeu.ok && rejeu.id]);
    expect(p.enfiles[1]!.startAfter).toEqual(p.enfiles[0]!.startAfter);
    // Encore en file mais périmée (plus de 24 h après son créneau) : le rejeu ne la réenfile pas, elle ne partira plus.
    const premierId = (premier as { id: string }).id;
    const enFile = p.file.lignes.get(premierId)!;
    p.file.lignes.set(premierId, { ...enFile, prevuLe: new Date(MAINTENANT.getTime() - PEREMPTION_MS - 1) });
    expect(await enfilerPremierMessage(p.deps, demande())).toMatchObject({ ok: true, id: premierId, dejaEnFile: true });
    expect(p.enfiles).toHaveLength(2);
    p.file.lignes.set(premierId, enFile);
    // Partie, la ligne n'est plus enfilée : le rejeu ne fait rien.
    const id = (premier as { id: string }).id;
    p.file.lignes.set(id, { ...p.file.lignes.get(id)!, statut: 'envoye' });
    expect(await enfilerPremierMessage(p.deps, demande())).toMatchObject({ ok: true, id, dejaEnFile: true });
    expect(p.enfiles).toHaveLength(2);
  });

  it('deux messages du même espace s’espacent ; un autre espace ne les gêne pas', async () => {
    const p = porte();
    const a = await enfilerPremierMessage(p.deps, demande({ cle: 'a' }));
    const b = await enfilerPremierMessage(p.deps, demande({ cle: 'b' }));
    const c = await enfilerPremierMessage(p.deps, demande({ cle: 'c', tenantId: T2 }));
    const t = (x: typeof a) => (x.ok ? x.prevuLe.getTime() - MAINTENANT.getTime() : NaN);
    expect([t(a), t(b), t(c)]).toEqual([45_000, 90_000, 45_000]);
  });

  /**
   * Les refus, DANS L'ORDRE : pour chaque porte, elle ET toutes les suivantes refuseraient ; c'est la première qui parle.
   * Après chacun, rien n'est inséré ni enfilé, et rien n'est compté (sauf la limite du mois, refusée par `consommer`).
   */
  const ORDRE: Array<{ refus: RefusPremier; reglages: Reglages; demande?: Partial<DemandePremierMessage> }> = [
    { refus: 'filiere_api', reglages: { filiere: 'api' } },
    { refus: 'numero_coupe', reglages: { statut: 'banni' } },
    { refus: 'numero_indisponible', reglages: { statut: 'deconnecte' } },
    { refus: 'gele', reglages: { gelJusqua: new Date(MAINTENANT.getTime() + 60_000) } },
    { refus: 'sans_telephone', reglages: {}, demande: { telephone: '12' } },
    { refus: 'limite_contacts', reglages: { fiche: { ok: false, code: 'plan_limit_reached' } } },
    { refus: 'desabonne', reglages: { consentement: 'refuse' } },
    { refus: 'desabonne', reglages: { desabonne: true } },
    { refus: 'bloque', reglages: { bloque: true } },
    { refus: 'limite_modeles', reglages: { quotaOk: false } },
  ];

  for (const [i, cas] of ORDRE.entries()) {
    it(`refus n° ${i + 1} : ${cas.refus}, avant tous les suivants, et rien ne part`, async () => {
      // Pour un même réglage (le statut du compte), c'est la porte testée qui l'emporte sur les suivantes.
      const suivants = ORDRE.slice(i).reverse();
      const reglages: Reglages = Object.assign({}, ...suivants.map((s) => s.reglages));
      const d = Object.assign({}, ...suivants.map((s) => s.demande ?? {}));
      const p = porte(reglages);
      expect(await enfilerPremierMessage(p.deps, demande(d))).toEqual({ ok: false, refus: cas.refus });
      expect(p.file.lignes.size).toBe(0);
      expect(p.enfiles).toEqual([]);
      expect(p.gestes.filter((g) => g.startsWith('quota'))).toEqual(cas.refus === 'limite_modeles' ? ['quota:1'] : []);
    });
  }

  it('numéro indisponible : un compte retiré, en attente de QR code, ou absent', async () => {
    for (const statut of ['retire', 'en_attente', null] as const) {
      const p = porte({ statut, filiere: statut === 'en_attente' ? 'application' : null });
      expect(await enfilerPremierMessage(p.deps, demande()), String(statut)).toEqual({ ok: false, refus: 'numero_indisponible' });
    }
  });

  it('un compte endormi passe (le job le réveille), un gel échu aussi', async () => {
    expect(await enfilerPremierMessage(porte({ statut: 'sommeil' }).deps, demande())).toMatchObject({ ok: true });
    expect(await enfilerPremierMessage(porte({ gelJusqua: new Date(MAINTENANT.getTime() - 1) }).deps, demande())).toMatchObject({ ok: true });
  });

  it('🔴 un numéro mal formé n’est jamais relu comme un numéro français : refusé, aucune fiche, rien ne part', async () => {
    // `+65 1234 567` (Singapour, un chiffre manquant) et des nationaux sans indicatif : `e164DepuisSaisie` en faisait des
    // mobiles français (relecture du lot B).
    for (const telephone of ['651234567', '712345678', '612345678', '212345678']) {
      const p = porte();
      expect(await enfilerPremierMessage(p.deps, demande({ telephone })), telephone).toEqual({ ok: false, refus: 'sans_telephone' });
      expect(p.gestes, telephone).toEqual([]);
      expect(p.enfiles, telephone).toEqual([]);
    }
    // Un numéro international valide passe, sous ses chiffres exacts.
    const p = porte();
    expect(await enfilerPremierMessage(p.deps, demande({ telephone: '6591234567' }))).toMatchObject({ ok: true });
    expect(p.gestes[0]).toBe('fiche:+6591234567:phone');
  });

  it('🔴 `conversation` (décision du 2026-10-24) : un contact qui nous a écrit reçoit la réponse sans accord coché, rien ne s’écrit sur sa fiche ; un STOP l’arrête', async () => {
    const conversation = { consentement: { mode: 'conversation' as const }, origine: 'reponse' as const };
    const p = porte({ optIn: 'unknown' });
    expect(await enfilerPremierMessage(p.deps, demande(conversation))).toMatchObject({ ok: true });
    expect(p.gestes).toEqual(['fiche:+33612345678:jamais', `lecture:${FICHE}`, 'stop:33612345678', 'tait:33612345678', 'quota:1']);
    expect(await enfilerPremierMessage(porte({ optIn: 'opted_out' }).deps, demande(conversation))).toEqual({ ok: false, refus: 'desabonne' });
  });

  it('un accord exigé ne crée pas de fiche : un inconnu est refusé sans consentement, sans user une place', async () => {
    const p = porte({ fiche: { ok: false, code: 'unknown_contact' } });
    expect(await enfilerPremierMessage(p.deps, demande({ consentement: { mode: 'exige_opt_in' } }))).toEqual({ ok: false, refus: 'sans_consentement' });
    expect(p.gestes[0]).toBe('fiche:+33612345678:jamais');
  });

  it('une fiche que l’on ne peut ni trouver ni créer : sans téléphone', async () => {
    const p = porte({ fiche: { ok: false, code: 'identity_conflict' } });
    expect(await enfilerPremierMessage(p.deps, demande())).toEqual({ ok: false, refus: 'sans_telephone' });
    // Le numéro part à la fiche en E.164 : `resoudreFiche` le lirait sinon comme un numéro français.
    expect(p.gestes[0]).toBe('fiche:+33612345678:phone');
  });

  it('🔴 `declare` écrit `opted_in` avec sa source AVANT le tri STOP et blocage', async () => {
    const p = porte();
    await enfilerPremierMessage(p.deps, demande({ origine: 'mcp', consentement: { mode: 'declare', source: 'formulaire du site' } }));
    expect(p.gestes).toEqual([
      'fiche:+33612345678:phone', `consentement:${FICHE}:opted_in:formulaire du site`, 'stop:33612345678', 'tait:33612345678', 'quota:1',
    ]);
  });

  it('une fiche effacée entre la résolution et le consentement : plus personne à qui écrire', async () => {
    expect(await enfilerPremierMessage(porte({ consentement: 'absente' }).deps, demande())).toEqual({ ok: false, refus: 'sans_telephone' });
  });

  it('🔴 `exige_opt_in` refuse une fiche non consentante, sans rien écrire ; une fiche consentante passe', async () => {
    const exige = { consentement: { mode: 'exige_opt_in' as const }, origine: 'reponse' as const };
    for (const optIn of ['unknown', null] as const) {
      const p = porte({ optIn });
      expect(await enfilerPremierMessage(p.deps, demande(exige)), String(optIn)).toEqual({ ok: false, refus: 'sans_consentement' });
      expect(p.gestes.some((g) => g.startsWith('consentement'))).toBe(false);
    }
    // Une fiche qui a dit STOP le dit, plutôt que « sans consentement ».
    expect(await enfilerPremierMessage(porte({ optIn: 'opted_out' }).deps, demande(exige))).toEqual({ ok: false, refus: 'desabonne' });
    const ok = porte({ optIn: 'opted_in' });
    expect(await enfilerPremierMessage(ok.deps, demande(exige))).toMatchObject({ ok: true });
    expect(ok.gestes).toEqual(['fiche:+33612345678:jamais', `lecture:${FICHE}`, 'stop:33612345678', 'tait:33612345678', 'quota:1']);
  });

  it('une demande hors des bornes de la migration est une faute de l’appelant : elle lève', async () => {
    await expect(enfilerPremierMessage(porte().deps, demande({ texte: '' }))).rejects.toThrow(/texte/);
    await expect(enfilerPremierMessage(porte().deps, demande({ cle: 'x'.repeat(201) }))).rejects.toThrow(/cle/);
  });

  it('🔴 les origines et les statuts sont ceux des CHECK de la migration 0252', () => {
    const sql = readFileSync(join(resolve(__dirname, '..'), 'db', 'migrations', '0252_premiers_messages.sql'), 'utf8');
    const liste = (colonne: string) => {
      const m = new RegExp(`${colonne}\\s+text not null[^\\n]*check \\(${colonne} in \\(([^)]*)\\)\\)`).exec(sql);
      return m ? [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : null;
    };
    expect(liste('origine')).toEqual([...ORIGINES_PREMIER]);
    expect(liste('statut')).toEqual([...STATUTS_PREMIER]);
  });
});

/** Le job monté sur des faux : le service, les contacts, la conversation, le courriel et l'appelant notent tout. */
function job(o: {
  statut?: StatutCompte | null;
  desabonne?: () => Promise<boolean>;
  bloque?: () => Promise<boolean>;
  verifier?: Resultat<Verification>;
  envoyer?: Resultat<{ messageId: string }>;
  origine?: OriginePremier;
  gelJusqua?: Date;
  /** Le réveil d'un compte endormi le relie (défaut), ou le laisse endormi. */
  reveil?: boolean;
  filiere?: 'api' | 'application' | null;
} = {}) {
  let maintenant = MAINTENANT;
  const file = fileEnMemoire(() => maintenant);
  if (o.gelJusqua) file.gels.set(COMPTE, o.gelJusqua);
  const service: string[] = [];
  const traces: string[] = [];
  const courriels: string[] = [];
  const issues: string[] = [];
  const enfiles: Array<{ id: string; startAfter: Date }> = [];
  let statut = o.statut === undefined ? 'relie' : o.statut;
  const client: Pick<ClientApplication, 'relier' | 'verifier' | 'envoyer'> = {
    relier: async (id) => { service.push(`relier:${id}`); if (o.reveil !== false) statut = 'relie'; return { ok: true }; },
    verifier: async (id, numero) => { service.push(`verifier:${id}:${numero}`); return o.verifier ?? { ok: true, present: true, adresse: 'lid' }; },
    envoyer: async (id, jid, texte) => { service.push(`envoyer:${id}:${jid}:${texte}`); return o.envoyer ?? { ok: true, messageId: 'WA7' }; },
  };
  const deps: DepsJobPremier = {
    premiers: file,
    comptes: {
      parEspace: async () => (statut ? compte(statut) : null),
      filiereDe: async () => { service.push('filiere'); return o.filiere === undefined ? 'application' : o.filiere; },
    },
    client,
    contacts: { estDesabonneParWaId: o.desabonne ?? jamaisDesabonne, machineSeTaitParWaId: o.bloque ?? jamaisBloque },
    inbox: {
      recordOutboundByWaId: async (t, waId, m) => { traces.push(`${t}:${waId}:${m.body}:${m.messageId}:${m.type}:${m.origine}`); },
    },
    prevenirDuGel: async (c, jusqua) => { courriels.push(`${c.id}:${jusqua.toISOString()}`); },
    enfiler: async (_t, id, startAfter) => { enfiles.push({ id, startAfter }); },
    noterIssue: async (origine, t, reference, issue) => { issues.push(`${origine}:${t}:${reference}:${issue}`); },
    maintenant: () => maintenant,
  };
  const poser = async (origine: OriginePremier = o.origine ?? 'shopify_commande') => (await file.inserer(
    { tenantId: T, cle: `cle-${file.lignes.size}`, waId: '33612345678', texte: 'Bonjour', origine, reference: 'ref-1' }, 0,
  )).ligne;
  return {
    deps, file, service, traces, courriels, issues, enfiles, poser,
    avancer(ms: number) { maintenant = new Date(maintenant.getTime() + ms); },
  };
}

const fini = (l: PremierMessage | undefined, issue: IssueJobPremier) => expect(l).toMatchObject({ statut: issue === 'envoye' ? 'envoye' : 'abandonne', issue });

describe('le job d’un premier message', () => {
  it('une ligne qui n’est plus en file ne fait rien : un job en double est inoffensif', async () => {
    const j = job();
    const l = await j.poser();
    await traiterPremierMessage(j.deps, { id: l.id });
    await traiterPremierMessage(j.deps, { id: l.id });
    await traiterPremierMessage(j.deps, { id: '00000000-0000-4000-8000-999999999999' });
    expect(j.service.filter((s) => s.startsWith('envoyer'))).toHaveLength(1);
    expect(j.issues).toHaveLength(1);
  });

  it('🔴 succès : vérifié, envoyé, tracé dans la conversation sans prendre le fil, inscrit `envoye`', async () => {
    const j = job();
    const l = await j.poser();
    await traiterPremierMessage(j.deps, { id: l.id });
    expect(j.service).toEqual(['filiere', `verifier:${COMPTE}:33612345678`, `envoyer:${COMPTE}:33612345678@s.whatsapp.net:Bonjour`]);
    // La conversation ne reçoit qu'une trace : la dépendance du job n'a pas de quoi prendre le fil.
    expect(j.traces).toEqual([`${T}:33612345678:Bonjour:app:${COMPTE}:WA7:text:campagne`]);
    expect(j.file.lignes.get(l.id)).toMatchObject({ statut: 'envoye', issue: 'envoye', messageId: `app:${COMPTE}:WA7` });
    expect(j.issues).toEqual([`shopify_commande:${T}:ref-1:envoye`]);
  });

  it('l’origine du message dans la conversation : `campagne` pour Shopify, `mcp` pour Claude, `api` pour l’API et la réponse', async () => {
    const j = job();
    for (const origine of ORIGINES_PREMIER) await traiterPremierMessage(j.deps, { id: (await j.poser(origine)).id });
    expect(j.traces.map((t) => t.split(':').pop())).toEqual(['campagne', 'campagne', 'mcp', 'api', 'api']);
  });

  it('🔴 un STOP posé après l’enfilement : rien ne part', async () => {
    const j = job({ desabonne: toujoursDesabonne });
    const l = await j.poser();
    await traiterPremierMessage(j.deps, { id: l.id });
    expect(j.service).toEqual([]);
    fini(j.file.lignes.get(l.id), 'desabonne');
    expect(j.issues).toEqual([`shopify_commande:${T}:ref-1:desabonne`]);
  });

  it('un contact bloqué après l’enfilement : rien ne part', async () => {
    const j = job({ bloque: async () => true });
    const l = await j.poser();
    await traiterPremierMessage(j.deps, { id: l.id });
    expect(j.service).toEqual([]);
    fini(j.file.lignes.get(l.id), 'bloque');
  });

  it('🔴 un compte banni : rien ne part, `numero_coupe`, et JAMAIS de relien', async () => {
    for (const statut of ['banni', 'deconnecte', 'retire', null] as const) {
      const j = job({ statut });
      const l = await j.poser();
      await traiterPremierMessage(j.deps, { id: l.id });
      expect(j.service, String(statut)).toEqual([]);
      fini(j.file.lignes.get(l.id), 'numero_coupe');
    }
  });

  it('un gel posé depuis l’enfilement : rien ne part, `gele`', async () => {
    const j = job({ gelJusqua: new Date(MAINTENANT.getTime() + 3_600_000) });
    const l = await j.poser();
    await traiterPremierMessage(j.deps, { id: l.id });
    expect(j.service).toEqual([]);
    fini(j.file.lignes.get(l.id), 'gele');
  });

  it('un numéro absent de WhatsApp : rien ne part, `pas_sur_whatsapp`', async () => {
    const j = job({ verifier: { ok: true, present: false, adresse: null } });
    const l = await j.poser();
    await traiterPremierMessage(j.deps, { id: l.id });
    expect(j.service).toEqual(['filiere', `verifier:${COMPTE}:33612345678`]);
    fini(j.file.lignes.get(l.id), 'pas_sur_whatsapp');
  });

  it('🔴 un refus de WhatsApp gèle les premiers messages 72 h et prévient une fois ; le suivant ne part pas', async () => {
    const j = job({ envoyer: { ok: false, raison: 'refuse_whatsapp' } });
    const a = await j.poser();
    const b = await j.poser();
    await traiterPremierMessage(j.deps, { id: a.id });
    const jusqua = new Date(MAINTENANT.getTime() + GEL_MS);
    expect(j.file.gels.get(COMPTE)).toEqual(jusqua);
    expect(GEL_MS).toBe(72 * 3_600_000);
    expect(j.courriels).toEqual([`${COMPTE}:${jusqua.toISOString()}`]);
    fini(j.file.lignes.get(a.id), 'refuse_whatsapp');
    // Le message suivant du même compte voit le gel, sans un mot de plus.
    await traiterPremierMessage(j.deps, { id: b.id });
    fini(j.file.lignes.get(b.id), 'gele');
    expect(j.service.filter((s) => s.startsWith('envoyer'))).toHaveLength(1);
    expect(j.courriels).toHaveLength(1);
  });

  it('deux refus pendant le même gel ne font qu’un courriel', async () => {
    const j = job({ envoyer: { ok: false, raison: 'refuse_whatsapp' } });
    // Les deux lignes ont passé la relecture du gel avant que le premier refus ne le pose.
    const a = await j.poser();
    const b = await j.poser();
    const geleJusqua = j.file.geleJusqua.bind(j.file);
    j.deps.premiers = { ...j.file, geleJusqua: async () => null };
    await traiterPremierMessage(j.deps, { id: a.id });
    await traiterPremierMessage(j.deps, { id: b.id });
    expect(j.courriels).toHaveLength(1);
    expect(await geleJusqua(COMPTE)).not.toBeNull();
  });

  it('🔴 un compte endormi : réveillé, puis remis en file une minute plus tard ; abandonné après trois essais', async () => {
    const j = job({ statut: 'sommeil' });
    const l = await j.poser();
    await traiterPremierMessage(j.deps, { id: l.id });
    expect(j.service).toEqual(['filiere', `relier:${COMPTE}`]);
    expect(j.file.lignes.get(l.id)).toMatchObject({ statut: 'en_file', essais: 1 });
    expect(j.enfiles).toEqual([{ id: l.id, startAfter: new Date(MAINTENANT.getTime() + REESSAI_MS) }]);
    expect(j.issues).toEqual([]);
    // Réveillé, l'essai suivant part.
    await traiterPremierMessage(j.deps, { id: l.id });
    expect(j.file.lignes.get(l.id)).toMatchObject({ statut: 'envoye', essais: 2 });
    // Resté endormi, il est réveillé à chaque essai, puis abandonné au troisième, sans rien envoyer.
    const dort = job({ statut: 'sommeil', reveil: false });
    const m = await dort.poser();
    for (let i = 0; i < 3; i += 1) await traiterPremierMessage(dort.deps, { id: m.id });
    expect(dort.service.filter((x) => x.startsWith('relier'))).toEqual([`relier:${COMPTE}`, `relier:${COMPTE}`, `relier:${COMPTE}`]);
    fini(dort.file.lignes.get(m.id), 'abandonne');
    expect(dort.issues).toEqual([`shopify_commande:${T}:ref-1:abandonne`]);
  });

  it('un service qui ne répond pas se réessaie trois fois, puis le message est abandonné', async () => {
    const j = job({ verifier: { ok: false, raison: 'service_injoignable' } });
    const l = await j.poser();
    for (let i = 0; i < 3; i += 1) await traiterPremierMessage(j.deps, { id: l.id });
    expect(j.enfiles).toHaveLength(2);
    fini(j.file.lignes.get(l.id), 'abandonne');
    expect(j.file.lignes.get(l.id)!.essais).toBe(3);
    expect(j.issues).toEqual([`shopify_commande:${T}:ref-1:abandonne`]);
    expect(j.service.some((s) => s.startsWith('envoyer'))).toBe(false);
  });

  it('🔴 le service ne répond pas à l’ENVOI : le message est peut-être parti, il ne repart jamais (`envoi_incertain`)', async () => {
    const j = job({ envoyer: { ok: false, raison: 'service_injoignable' } });
    const l = await j.poser();
    await traiterPremierMessage(j.deps, { id: l.id });
    fini(j.file.lignes.get(l.id), 'envoi_incertain');
    expect(j.enfiles).toEqual([]);
    expect(j.service.filter((s) => s.startsWith('envoyer'))).toHaveLength(1);
    expect(j.issues).toEqual([`shopify_commande:${T}:ref-1:envoi_incertain`]);
    // Un job en double ne trouve plus rien à réclamer.
    await traiterPremierMessage(j.deps, { id: l.id });
    expect(j.service.filter((s) => s.startsWith('envoyer'))).toHaveLength(1);
  });

  it('🔴 réclamée plus de 24 heures après son créneau, une ligne ne part plus (`expire`) ; à 24 heures pile, si', async () => {
    const j = job();
    const l = await j.poser();
    j.avancer(l.prevuLe.getTime() - MAINTENANT.getTime() + PEREMPTION_MS + 1);
    await traiterPremierMessage(j.deps, { id: l.id });
    expect(j.service).toEqual([]);
    fini(j.file.lignes.get(l.id), 'expire');
    expect(j.issues).toEqual([`shopify_commande:${T}:ref-1:expire`]);
    const k = job();
    const m = await k.poser();
    k.avancer(m.prevuLe.getTime() - MAINTENANT.getTime() + PEREMPTION_MS);
    await traiterPremierMessage(k.deps, { id: m.id });
    fini(k.file.lignes.get(m.id), 'envoye');
  });

  it('🔴 un espace passé à l’API depuis l’enfilement : rien ne part, ni vérification ni réveil (`filiere_api`)', async () => {
    for (const filiere of ['api', null] as const) {
      const j = job({ filiere, statut: 'sommeil' });
      const l = await j.poser();
      await traiterPremierMessage(j.deps, { id: l.id });
      expect(j.service, String(filiere)).toEqual(['filiere']);
      fini(j.file.lignes.get(l.id), 'filiere_api');
    }
  });

  it('un envoi refusé parce que la session n’est pas ouverte se réessaie ; un compte que le service ne connaît plus est coupé', async () => {
    const pasOuvert = job({ envoyer: { ok: false, raison: 'non_relie' } });
    const a = await pasOuvert.poser();
    await traiterPremierMessage(pasOuvert.deps, { id: a.id });
    expect(pasOuvert.file.lignes.get(a.id)).toMatchObject({ statut: 'en_file' });
    const inconnu = job({ envoyer: { ok: false, raison: 'compte_inconnu' } });
    const b = await inconnu.poser();
    await traiterPremierMessage(inconnu.deps, { id: b.id });
    fini(inconnu.file.lignes.get(b.id), 'numero_coupe');
  });

  it('une lecture en échec avant l’envoi remet la ligne en file plutôt que de la laisser réclamée', async () => {
    const j = job({ desabonne: async () => { throw new Error('base indisponible'); } });
    const l = await j.poser();
    await traiterPremierMessage(j.deps, { id: l.id });
    expect(j.file.lignes.get(l.id)).toMatchObject({ statut: 'en_file' });
    expect(j.service).toEqual([]);
  });

  it('🔴 envoyé mais non tracé : le message reste `envoye`, il ne repart pas', async () => {
    const j = job();
    j.deps.inbox = { recordOutboundByWaId: async () => { throw new Error('conversation verrouillée'); } };
    const l = await j.poser();
    await traiterPremierMessage(j.deps, { id: l.id });
    fini(j.file.lignes.get(l.id), 'envoye');
    expect(j.enfiles).toEqual([]);
  });
});

describe('l’enfilement', () => {
  it('🔴 groupé par espace (un envoi à la fois par numéro), pas avant le créneau, et la ligne seule dans le job', async () => {
    const enfiles: unknown[] = [];
    const startAfter = new Date('2026-10-23T10:00:45Z');
    await enfileurPremier({ enqueue: async (nom, data, opts) => { enfiles.push([nom, data, opts]); } })(T, 'ligne-1', startAfter);
    expect(enfiles).toEqual([[FILE_PREMIER_MESSAGE, { id: 'ligne-1' }, { groupId: T, startAfter }]]);
  });
});

describe('le courriel d’un gel', () => {
  it('prévient les admins, une occasion par compte et par gel', async () => {
    const emis: Emission[] = [];
    const prevenir = avisDeGel(async (e) => { emis.push(e); });
    const jusqua = new Date('2026-10-26T10:00:00Z');
    await prevenir(compte('relie'), jusqua);
    expect(emis.map((e) => [e.cle, e.occasion, e.a, e.valeurs.numero])).toEqual([
      ['application_premiers_geles', `gel:${COMPTE}:2026-10-26T10:00:00.000Z`, 'admins', '+447700900000'],
    ]);
  });
});
