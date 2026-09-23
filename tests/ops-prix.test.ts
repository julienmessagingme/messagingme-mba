import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { GRILLE_DEFAUT, type GrillePrix } from '../src/stats/prix';
import type { OpsRouteDeps } from '../src/http/ops';
import { capturerJournal } from './journal';

/**
 * LA GRILLE DE PRIX SE REGLE DANS /ops, UNE FOIS, POUR TOUS LES ESPACES (lot 8, migration 0168).
 *
 * 🔴 CE QUE CE FICHIER REMPLACE, ET CE QU IL CONSERVE. Ces cas vivaient sur
 * `PATCH /tenants/:t/settings/prix`, c est-a-dire derriere le JWT du CLIENT : il fixait lui-meme ce qu on
 * lui facture. Julien a tranche le 2026-09-23. Cinq des sept cas d alors se transposent tels quels ; les
 * deux qui portaient sur le TENANT disparaissent avec leur sujet, parce que la route n a plus de tenant, et
 * leur equivalent est l autorite separee de /ops, gardee par `tests/ops.test.ts`.
 *
 * 🔴 ET LA TRACE EST UN CAS A PART ENTIERE. Le jeton d exploitation est PARTAGE : il n y a aucune identite
 * d operateur a enregistrer, donc la note est la seule reponse a « qui a change ce prix, et pourquoi ». Un
 * prix qui change sans trace est ce qu un audit reproche en premier.
 */
const OPS = 'ops-secret-token-of-at-least-32-bytes!!';
const withTok = (t: string) => ({ headers: { 'content-type': 'application/json', 'x-ops-token': t } });

const BONNE: GrillePrix = {
  margeTemplate: 120, serviceCentimes: 2.48, serviceFranchise: 1000,
  serviceDepuis: '2026-10-01', rcsSimpleCentimes: 6, rcsConversationnelCentimes: 8,
};
const NOTE = 'passage a 120 pour la grille 2027, valide par Julien';

function app(over: Partial<OpsRouteDeps> = {}) {
  const deps: OpsRouteDeps = {
    getTenantOverview: async () => [],
    getGlobalDaily: async () => [],
    getQueueLoad: async () => [],
    ...over,
  };
  return buildServer({ queue: new FakeQueue(), ops: deps, opsToken: OPS });
}

describe('GET /ops/prix', () => {
  it('rend la grille ET ses bornes : l ecran ne les redeclare pas', async () => {
    // Deux jeux de bornes pour une meme valeur, c est un 500 au lieu d un message. L ecran affiche celles
    // que le serveur applique, il ne les recopie pas.
    const a = app({ lireGrillePrix: async () => BONNE });
    const res = await a.inject({ method: 'GET', url: '/ops/prix', ...withTok(OPS) });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ prix: GrillePrix; bornes: Record<string, unknown> }>();
    expect(body.prix).toEqual(BONNE);
    expect(body.bornes, 'les bornes voyagent avec la grille').toBeTruthy();
    await a.close();
  });

  it('cablage absent -> 503, et l ecran masque la carte plutot que d offrir un formulaire inerte', async () => {
    const a = app();
    expect((await a.inject({ method: 'GET', url: '/ops/prix', ...withTok(OPS) })).statusCode).toBe(503);
    await a.close();
  });

  it('🔴 sans le jeton d exploitation -> refus, et la grille ne fuit pas', async () => {
    let lu = false;
    const a = app({ lireGrillePrix: async () => { lu = true; return GRILLE_DEFAUT; } });
    const res = await a.inject({ method: 'GET', url: '/ops/prix' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(lu, 'la garde se pose AVANT la lecture').toBe(false);
    await a.close();
  });
});

describe('PATCH /ops/prix', () => {
  it('jeton correct -> 200, et le store recoit les SIX champs', async () => {
    let recu: GrillePrix | null = null;
    const a = app({ ecrireGrillePrix: async (g) => { recu = g; } });
    const res = await a.inject({ method: 'PATCH', url: '/ops/prix', payload: { ...BONNE, note: NOTE }, ...withTok(OPS) });
    expect(res.statusCode).toBe(200);
    // La grille voyage ENTIERE, jamais champ par champ : un objet ne peut pas perdre un membre en chemin.
    expect(recu).toEqual(BONNE);
    await a.close();
  });

  /**
   * 🔴 LE 400 NOMME LE CHAMP, et c est ce qui distingue un refus utilisable d un refus opaque. Un « erreur »
   * nu obligerait a chercher lequel des six ne va pas.
   */
  it('🔴 une valeur hors bornes -> 400 qui NOMME le champ, et rien n est ecrit', async () => {
    let appele = false;
    const a = app({ ecrireGrillePrix: async () => { appele = true; } });
    const res = await a.inject({ method: 'PATCH', url: '/ops/prix',
      payload: { ...BONNE, serviceCentimes: 248, note: NOTE }, ...withTok(OPS) });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ champ: string }>().champ).toBe('serviceCentimes');
    expect(appele, 'rien ne doit partir en base quand la saisie est refusee').toBe(false);
    await a.close();
  });

  it('🔴 une grille INCOMPLETE est refusee, elle n est pas completee par les defauts', async () => {
    // Un envoi partiel obligerait le serveur a fusionner avec l existant : c est la ou ce depot s est deja
    // fait avoir, une liste REMPLACEE au lieu d etre fusionnee.
    const a = app({ ecrireGrillePrix: async () => {} });
    const res = await a.inject({ method: 'PATCH', url: '/ops/prix', payload: { margeTemplate: 120, note: NOTE }, ...withTok(OPS) });
    expect(res.statusCode).toBe(400);
    await a.close();
  });

  it('🔴 SANS NOTE -> 400, et rien n est ecrit : c est la seule trace de qui a change le prix', async () => {
    // Le jeton d exploitation est PARTAGE, donc il n y a aucune identite d operateur a enregistrer. Meme
    // exigence que le rechargement d un solde, et pour la meme raison.
    let appele = false;
    const a = app({ ecrireGrillePrix: async () => { appele = true; } });
    for (const payload of [{ ...BONNE }, { ...BONNE, note: '' }, { ...BONNE, note: '  ' }, { ...BONNE, note: 42 }]) {
      const res = await a.inject({ method: 'PATCH', url: '/ops/prix', payload, ...withTok(OPS) });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(appele).toBe(false);
    await a.close();
  });

  it('🔴 LA NOTE EST TRANSMISE AU STORE, pas seulement exigee a la porte', async () => {
    // Une note obligatoire qu on jette est pire qu aucune note : l ecran promet une tracabilite que la base
    // n a pas. C est le motif « une garde qu on peut debrancher sans qu aucun test ne tombe ».
    let recue: string | null = null;
    const a = app({ ecrireGrillePrix: async (_g, par) => { recue = par; } });
    await a.inject({ method: 'PATCH', url: '/ops/prix', payload: { ...BONNE, note: NOTE }, ...withTok(OPS) });
    expect(recue).toBe(NOTE);
    await a.close();
  });

  it('🔴 le changement est JOURNALISE en warn, avec la grille et la note', async () => {
    // Un appel au journal qui ne part pas ne leve rien : seul un test qui LIT la sortie distingue une trace
    // d un appel muet.
    const { lignes } = await capturerJournal(async () => {
      const a = app({ ecrireGrillePrix: async () => {} });
      await a.inject({ method: 'PATCH', url: '/ops/prix', payload: { ...BONNE, note: NOTE }, ...withTok(OPS) });
      await a.close();
    });
    const ligne = lignes.find((l) => l.msg === 'ops_grille_prix');
    expect(ligne, 'un prix qui change sans trace est ce qu un audit reproche en premier').toBeTruthy();
    expect(ligne?.lvl).toBe('warn');
    expect(ligne?.note).toBe(NOTE);
    expect(ligne?.prix, 'la grille POSEE, pas seulement le fait qu on y a touche').toEqual(BONNE);
  });

  it('cablage absent -> 503, jamais un succes silencieux', async () => {
    const a = app();
    expect((await a.inject({ method: 'PATCH', url: '/ops/prix', payload: { ...BONNE, note: NOTE }, ...withTok(OPS) })).statusCode).toBe(503);
    await a.close();
  });

  it('🔴 sans le jeton d exploitation -> refus, et RIEN n est ecrit', async () => {
    // L equivalent des deux cas disparus (un agent refuse, un tenant etranger refuse) : cette route n a plus
    // de tenant, sa garde est l autorite separee de /ops.
    let appele = false;
    const a = app({ ecrireGrillePrix: async () => { appele = true; } });
    const res = await a.inject({ method: 'PATCH', url: '/ops/prix', payload: { ...BONNE, note: NOTE }, headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(appele).toBe(false);
    await a.close();
  });

  it('🔴 un JETON FAUX ne passe pas non plus', async () => {
    let appele = false;
    const a = app({ ecrireGrillePrix: async () => { appele = true; } });
    const res = await a.inject({ method: 'PATCH', url: '/ops/prix', payload: { ...BONNE, note: NOTE }, ...withTok('mauvais-jeton-de-plus-de-32-octets!!!') });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(appele).toBe(false);
    await a.close();
  });
});
