import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { FakeQueue } from './fake-queue';
import { AUTOMATION_EVENT_QUEUE, parseAutomationEventJob } from '../src/automation/event-job';
import {
  PLAFOND_DECLENCHEMENTS_PAR_JOUR, TAILLE_LOT_RISQUE, balayerRisque, balayerRisqueEspace, debutDuJour, departDuDeclencheur,
  jourABalayer, type DepsBalayageRisque, type HorairesEspace,
} from '../src/engagement/balayage';
import { DEFAULT_BUSINESS_HOURS } from '../src/settings/store.pg';
import { depsBalayageRisque } from '../src/engagement/cablage';
import type { ContactAEvaluer, TransitionRisque } from '../src/engagement/risque.pg';
import type { FaitsRisque, NiveauRisque, Risque } from '../src/engagement/risque';
import { creerEmetteur } from '../src/signaux/emetteur';
import { schemaSignal, type Signal } from '../src/signaux/types';

/**
 * LE BALAYAGE DU RISQUE (tâche 4 du plan du lot 7) : transitions, signaux, et le déclencheur de MASSE avec ses
 * trois bornes. IO en mémoire : un faux dépôt qui garde le niveau de chaque fiche d'une passe à l'autre.
 */

const T = '0b8f5c1e-3d2a-4c6b-9e7f-1a2b3c4d5e6f';
const T2 = '1c9f6d2f-4e3b-4d7c-8f80-2b3c4d5e6f70';
/** Vendredi 25 septembre 2026, 5 h à Paris (UTC+2) : dans la fenêtre du balayage de nuit. */
const MAINTENANT = new Date('2026-09-25T03:00:00.000Z');
/** 9 h à Paris le même vendredi : l'ouverture des horaires par défaut (lundi au vendredi, 9 h à 18 h). */
const NEUF_HEURES = new Date('2026-09-25T07:00:00.000Z');
const HORAIRES_PAR_DEFAUT: HorairesEspace = { timeZone: 'Europe/Paris', businessHours: DEFAULT_BUSINESS_HOURS };
const JOUR = 86_400_000;
const ilYa = (jours: number): Date => new Date(MAINTENANT.getTime() - jours * JOUR);
const uuid = (i: number): string => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;

/** Un contact qui décroche : 80 jours de silence, trois messages délivrés sans réponse ni lecture, et il lit d'habitude. */
const DECROCHE: FaitsRisque = {
  desabonne: false, bloque: false,
  delivres: [85, 70, 65, 62].map((j, i) => ({ envoyeLe: ilYa(j), lu: i === 0, luLe: i === 0 ? ilYa(j) : null })),
  derniereReactionLe: null, derniereAnalyse: null, joignableWhatsapp: true, joignableRcs: null,
};
/** Un contact qui répond : faible. */
const VIVANT: FaitsRisque = { ...DECROCHE, delivres: [{ envoyeLe: ilYa(5), lu: true, luLe: ilYa(4) }], derniereReactionLe: ilYa(2) };

interface FicheMemoire { faits: FaitsRisque; niveau: NiveauRisque | null; waId: string | null }

function depot(fiches: Map<string, FicheMemoire>) {
  const appels = { faits: [] as number[], ecritures: 0 };
  const deps = {
    contactsAEvaluer: async () => [...fiches.keys()],
    faits: async (_t: string, ids: readonly string[]): Promise<ContactAEvaluer[]> => {
      appels.faits.push(ids.length);
      return ids.map((id) => ({ contactId: id, niveauStocke: fiches.get(id)!.niveau, faits: fiches.get(id)!.faits }));
    },
    ecrire: async (_t: string, lignes: ReadonlyArray<{ contactId: string; risque: Risque }>): Promise<TransitionRisque[]> => {
      appels.ecritures += lignes.length;
      const out: TransitionRisque[] = [];
      for (const l of lignes) {
        const f = fiches.get(l.contactId)!;
        const ancien = f.niveau;
        f.niveau = l.risque.niveau;
        if (ancien !== l.risque.niveau) out.push({ contactId: l.contactId, waId: f.waId, ancien, nouveau: l.risque.niveau, score: l.risque.score, raisons: l.risque.raisons });
      }
      return out;
    },
  };
  return { deps, appels };
}

function monter(fiches: Map<string, FicheMemoire>, over: Partial<DepsBalayageRisque> = {}) {
  const { deps: stock, appels } = depot(fiches);
  const publies: Array<{ tenantId: string; waId: string }> = [];
  const departs: Date[] = [];
  const signaux: Signal[] = [];
  const journal: string[] = [];
  const deps: DepsBalayageRisque = {
    espaces: async () => [T],
    ...stock,
    declenchablesDepuis: async () => 0,
    automationRisqueActive: async () => true,
    horairesOuvres: async () => HORAIRES_PAR_DEFAUT,
    publierRisqueEleve: async (tenantId, waId, depart) => { publies.push({ tenantId, waId }); departs.push(depart); },
    emettreSignaux: async (_t, s) => { signaux.push(...s); },
    maintenant: () => MAINTENANT,
    log: (m) => journal.push(m),
    ...over,
  };
  return { deps, publies, departs, signaux, journal, appels };
}

const fichesDe = (n: number, faits: FaitsRisque, niveau: NiveauRisque | null = null): Map<string, FicheMemoire> =>
  new Map(Array.from({ length: n }, (_, i) => [uuid(i + 1), { faits, niveau, waId: `3360000${String(i).padStart(4, '0')}` }]));

describe('les transitions et les signaux', () => {
  it('🔴 un passage en élevé : écrit, signalé, et l’automation publiée UNE fois ; la nuit suivante, rien', async () => {
    const fiches = fichesDe(1, DECROCHE, 'moyen');
    const { deps, publies, signaux } = monter(fiches);

    const b1 = await balayerRisqueEspace(T, deps);
    expect(b1).toMatchObject({ evalues: 1, transitions: 1, declenches: 1, auDelaDuPlafond: 0 });
    expect(fiches.get(uuid(1))!.niveau).toBe('eleve');
    expect(publies).toEqual([{ tenantId: T, waId: '33600000000' }]);
    expect(signaux).toHaveLength(1);
    expect(signaux[0]).toMatchObject({ nom: 'em_risk_changed', contactId: uuid(1), niveau: 'eleve', ancienNiveau: 'moyen', score: 70, raisons: ['silence_60j', 'sans_reponse', 'non_lu'] });
    // Le signal émis est bien dans le contrat de la file (l'émetteur le revalide, et le refuserait sinon).
    expect(schemaSignal.safeParse(signaux[0]).success).toBe(true);

    // 🔴 RESTER en élevé n'est pas un passage : ni signal, ni automation.
    const b2 = await balayerRisqueEspace(T, deps);
    expect(b2).toMatchObject({ evalues: 1, transitions: 0, declenches: 0 });
    expect(publies).toHaveLength(1);
    expect(signaux).toHaveLength(1);
  });

  it('un changement qui n’est PAS un passage en élevé signale, mais ne déclenche rien', async () => {
    const fiches = fichesDe(1, VIVANT, 'eleve');
    const { deps, publies, signaux } = monter(fiches);
    const b = await balayerRisqueEspace(T, deps);
    expect(b).toMatchObject({ transitions: 1, declenches: 0 });
    expect(signaux[0]).toMatchObject({ niveau: 'faible', ancienNiveau: 'eleve' });
    expect(publies).toEqual([]);
  });

  it('les fiches se lisent et s’écrivent par LOTS, jamais une à une', async () => {
    const n = TAILLE_LOT_RISQUE * 2 + 7;
    const { deps, appels } = monter(fichesDe(n, VIVANT, 'faible'));
    const b = await balayerRisqueEspace(T, deps);
    expect(appels.faits).toEqual([TAILLE_LOT_RISQUE, TAILLE_LOT_RISQUE, 7]);
    expect(b.evalues).toBe(n);
  });
});

describe('🔴 le déclencheur de MASSE et ses bornes (exception décidée par Julien, spec § 19)', () => {
  it(`au plus ${PLAFOND_DECLENCHEMENTS_PAR_JOUR} déclenchements par jour et par espace : le reste est ÉCRIT sans déclencher, et journalisé`, async () => {
    const fiches = fichesDe(PLAFOND_DECLENCHEMENTS_PAR_JOUR + 50, DECROCHE, 'moyen');
    const { deps, publies, signaux, journal } = monter(fiches);
    const b = await balayerRisqueEspace(T, deps);
    expect(b).toMatchObject({ transitions: 250, declenches: PLAFOND_DECLENCHEMENTS_PAR_JOUR, auDelaDuPlafond: 50, dejaDeclenches: 0 });
    expect(publies).toHaveLength(PLAFOND_DECLENCHEMENTS_PAR_JOUR);
    // Tous écrits, tous signalés : le plafond ne borne que les automations.
    expect([...fiches.values()].every((f) => f.niveau === 'eleve')).toBe(true);
    expect(signaux).toHaveLength(250);
    expect(journal.some((m) => m.includes(`plafond de ${PLAFOND_DECLENCHEMENTS_PAR_JOUR}`) && m.includes('50'))).toBe(true);
    // Et la nuit suivante, ceux qui n'ont pas déclenché ne déclenchent pas non plus : ils sont déjà en élevé.
    expect((await balayerRisqueEspace(T, deps)).declenches).toBe(0);
  });

  /**
   * 🔴 LE PLAFOND EST CELUI DE LA JOURNÉE, PAS DE L'EXÉCUTION (relecture du lot 7). Compté par exécution, un
   * lancement `/ops` à 10 h s'ajoutait aux 200 de la nuit.
   */
  it('🔴 le plafond compte ce que la journée a DÉJÀ déclenché : un second passage ne garde que le reste', async () => {
    const demandes: Array<{ tenantId: string; depuis: Date; ecrituresAvant: number }> = [];
    const fiches = fichesDe(80, DECROCHE, 'moyen');
    const { deps, publies, journal, appels } = monter(fiches, {
      declenchablesDepuis: async (tenantId, depuis) => { demandes.push({ tenantId, depuis, ecrituresAvant: appels.ecritures }); return 150; },
    });
    const b = await balayerRisqueEspace(T, deps);
    expect(b).toMatchObject({ transitions: 80, dejaDeclenches: 150, declenches: 50, auDelaDuPlafond: 30 });
    expect(publies).toHaveLength(50);
    // Depuis MINUIT À PARIS (22 h UTC la veille, en heure d'été), et lu AVANT la première écriture : après, ce
    // passage-ci se compterait lui-même.
    expect(demandes).toEqual([{ tenantId: T, depuis: new Date('2026-09-24T22:00:00.000Z'), ecrituresAvant: 0 }]);
    expect(journal.some((m) => m.includes('150 avant ce passage'))).toBe(true);
  });

  it('🔴 un plafond du jour déjà atteint : tout est écrit et signalé, RIEN ne part', async () => {
    const fiches = fichesDe(5, DECROCHE, 'moyen');
    const { deps, publies, signaux } = monter(fiches, { declenchablesDepuis: async () => PLAFOND_DECLENCHEMENTS_PAR_JOUR + 12 });
    const b = await balayerRisqueEspace(T, deps);
    expect(b).toMatchObject({ transitions: 5, declenches: 0, auDelaDuPlafond: 5, departLe: null });
    expect(publies).toEqual([]);
    expect(signaux).toHaveLength(5);
  });

  it('un espace sans fiche à évaluer ne pose même pas la question du plafond', async () => {
    let questions = 0;
    const { deps } = monter(new Map(), { declenchablesDepuis: async () => { questions += 1; return 0; } });
    expect(await balayerRisqueEspace(T, deps)).toMatchObject({ evalues: 0, dejaDeclenches: 0 });
    expect(questions).toBe(0);
  });

  it('le plafond est PAR ESPACE : un espace qui l’atteint n’en prive pas le suivant', async () => {
    const parEspace = new Map([[T, fichesDe(3, DECROCHE, 'moyen')], [T2, fichesDe(3, DECROCHE, 'moyen')]]);
    const publies: string[] = [];
    const deps: DepsBalayageRisque = {
      ...monter(new Map()).deps,
      espaces: async () => [T, T2],
      contactsAEvaluer: async (t) => [...parEspace.get(t)!.keys()],
      faits: async (t, ids) => depot(parEspace.get(t)!).deps.faits(t, ids),
      ecrire: async (t, l) => depot(parEspace.get(t)!).deps.ecrire(t, l),
      publierRisqueEleve: async (t) => { publies.push(t); },
      plafondDeclenchements: 2,
    };
    const bilans = await balayerRisque(deps);
    expect(bilans.map((b) => [b.declenches, b.auDelaDuPlafond])).toEqual([[2, 1], [2, 1]]);
    expect(publies).toEqual([T, T, T2, T2]);
  });

  it('🔴 STOP et blocage donnent « élevé » mais ne DÉCLENCHENT rien, et n’usent pas le plafond', async () => {
    const fiches = new Map<string, FicheMemoire>([
      [uuid(1), { faits: { ...VIVANT, desabonne: true }, niveau: null, waId: '33600000001' }],
      [uuid(2), { faits: { ...VIVANT, bloque: true }, niveau: 'faible', waId: '33600000002' }],
      [uuid(3), { faits: DECROCHE, niveau: 'moyen', waId: '33600000003' }],
    ]);
    const { deps, publies } = monter(fiches, { plafondDeclenchements: 1 });
    const b = await balayerRisqueEspace(T, deps);
    expect(b).toMatchObject({ transitions: 3, declenches: 1, sansDeclencheur: 2, auDelaDuPlafond: 0 });
    expect(publies).toEqual([{ tenantId: T, waId: '33600000003' }]);
  });

  it('sans automation « risque élevé » active : rien n’est publié, la question n’est posée qu’une fois', async () => {
    let questions = 0;
    const { deps, publies } = monter(fichesDe(5, DECROCHE, 'moyen'), { automationRisqueActive: async () => { questions += 1; return false; } });
    const b = await balayerRisqueEspace(T, deps);
    expect(b).toMatchObject({ transitions: 5, declenches: 0, sansDeclencheur: 5, auDelaDuPlafond: 0 });
    expect(publies).toEqual([]);
    expect(questions).toBe(1);
  });

  it('⚠️ aucun passage en élevé : la question de l’automation n’est même pas posée', async () => {
    let questions = 0;
    const { deps } = monter(fichesDe(2, VIVANT, 'moyen'), { automationRisqueActive: async () => { questions += 1; return true; } });
    await balayerRisqueEspace(T, deps);
    expect(questions).toBe(0);
  });

  it('une publication qui échoue est comptée et journalisée, le lot continue', async () => {
    let n = 0;
    const { deps, journal } = monter(fichesDe(3, DECROCHE, 'moyen'), {
      publierRisqueEleve: async () => { n += 1; if (n === 1) throw new Error('file indisponible'); },
    });
    const b = await balayerRisqueEspace(T, deps);
    expect(b).toMatchObject({ declenches: 2, echecsPublication: 1 });
    expect(journal.some((m) => m.includes('file indisponible'))).toBe(true);
  });
});

/**
 * 🔴 L'AUTOMATION « RISQUE ÉLEVÉ » NE PART PAS LA NUIT (relecture du lot 7). Le scénario commence par un template :
 * publié pendant le balayage, il partait vers 3 h du matin. L'événement attend l'ouverture de l'espace.
 */
describe('🔴 le départ de l’automation : à l’ouverture de l’espace, jamais pendant le balayage de nuit', () => {
  it('le balayage de 5 h (Paris) publie un événement qui attend 9 h, l’ouverture de l’espace, et le bilan le dit', async () => {
    const { deps, departs } = monter(fichesDe(3, DECROCHE, 'moyen'));
    const b = await balayerRisqueEspace(T, deps);
    expect(departs).toEqual([NEUF_HEURES, NEUF_HEURES, NEUF_HEURES]);
    expect(b.departLe).toBe(NEUF_HEURES.toISOString());
  });

  it('les horaires ne sont lus qu’une fois par espace, et seulement s’il y a quelque chose à publier', async () => {
    let lectures = 0;
    const horairesOuvres = async (): Promise<HorairesEspace> => { lectures += 1; return HORAIRES_PAR_DEFAUT; };
    await balayerRisqueEspace(T, monter(fichesDe(4, DECROCHE, 'moyen'), { horairesOuvres }).deps);
    expect(lectures).toBe(1);
    await balayerRisqueEspace(T, monter(fichesDe(4, VIVANT, 'moyen'), { horairesOuvres }).deps);
    expect(lectures).toBe(1);
  });

  it('🔴 des horaires illisibles (lecture en échec) : 9 h (Paris), jamais « tout de suite », qui serait la nuit', async () => {
    const { deps, departs } = monter(fichesDe(1, DECROCHE, 'moyen'), { horairesOuvres: async () => { throw new Error('base indisponible'); } });
    expect(await balayerRisqueEspace(T, deps)).toMatchObject({ declenches: 1 });
    expect(departs).toEqual([NEUF_HEURES]);
  });
});

describe('departDuDeclencheur', () => {
  const paris = HORAIRES_PAR_DEFAUT;
  it('la nuit d’un jour ouvré : l’ouverture du matin même', () => {
    expect(departDuDeclencheur(MAINTENANT, paris)).toEqual(NEUF_HEURES);
  });
  it('la nuit du samedi : le lundi à l’ouverture, le week-end est franchi', () => {
    expect(departDuDeclencheur(new Date('2026-09-26T03:00:00.000Z'), paris)).toEqual(new Date('2026-09-28T07:00:00.000Z'));
  });
  it('un lancement `/ops` pendant les heures d’ouverture : tout de suite', () => {
    const midi = new Date('2026-09-25T10:00:00.000Z');
    expect(departDuDeclencheur(midi, paris)).toEqual(midi);
  });
  it('les horaires sont ceux de l’espace, dans SON fuseau', () => {
    expect(departDuDeclencheur(MAINTENANT, { timeZone: 'America/New_York', businessHours: DEFAULT_BUSINESS_HOURS }))
      .toEqual(new Date('2026-09-25T13:00:00.000Z'));
  });
  it('🔴 un espace sans heures d’ouverture (tout fermé, ou rien de lisible) : 9 h à Paris le matin même, sinon le lendemain', () => {
    const fermeTousLesJours = Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((j) => [j, { closed: true, open: '', close: '' }]));
    expect(departDuDeclencheur(MAINTENANT, null)).toEqual(NEUF_HEURES);
    expect(departDuDeclencheur(MAINTENANT, { timeZone: 'Europe/Paris', businessHours: fermeTousLesJours })).toEqual(NEUF_HEURES);
    // Un samedi aussi : le repli ne connaît pas de jour fermé.
    expect(departDuDeclencheur(new Date('2026-09-26T03:00:00.000Z'), null)).toEqual(new Date('2026-09-26T07:00:00.000Z'));
    // Après 18 h (Paris) : le lendemain à 9 h, jamais le soir même.
    expect(departDuDeclencheur(new Date('2026-09-25T19:00:00.000Z'), null)).toEqual(new Date('2026-09-26T07:00:00.000Z'));
  });
});

describe('debutDuJour : minuit à Paris', () => {
  it('en heure d’été comme en heure d’hiver', () => {
    expect(debutDuJour(MAINTENANT)).toEqual(new Date('2026-09-24T22:00:00.000Z'));
    expect(debutDuJour(new Date('2026-12-15T10:00:00.000Z'))).toEqual(new Date('2026-12-14T23:00:00.000Z'));
    // 23 h 30 UTC le 24 septembre, c'est déjà le 25 à Paris.
    expect(debutDuJour(new Date('2026-09-24T23:30:00.000Z'))).toEqual(new Date('2026-09-24T22:00:00.000Z'));
  });
});

describe('🔴 une panne d’un espace n’arrête pas le suivant', () => {
  it('l’espace en panne est dans son bilan, le suivant est balayé', async () => {
    const fiches = fichesDe(1, DECROCHE, 'moyen');
    const { deps, journal } = monter(fiches, {
      espaces: async () => [T2, T],
      contactsAEvaluer: async (t) => { if (t === T2) throw new Error('base indisponible'); return [uuid(1)]; },
    });
    const bilans = await balayerRisque(deps);
    expect(bilans[0]).toMatchObject({ tenantId: T2, erreur: 'base indisponible', evalues: 0 });
    expect(bilans[1]).toMatchObject({ tenantId: T, evalues: 1, transitions: 1, declenches: 1 });
    expect(bilans[1]!.erreur).toBeUndefined();
    expect(journal.some((m) => m.includes(T2) && m.includes('base indisponible'))).toBe(true);
  });
});

describe('le câblage partagé (worker et /ops)', () => {
  const pool = {} as Pool;

  it('🔴 il ne publie QUE `risque_eleve`, par le seul chemin d’enfilement, avec l’espace comme groupe', async () => {
    const file = new FakeQueue();
    const deps = depsBalayageRisque({ pool, file, emetteur: { emettreSignaux: async () => {} }, automationsActives: async () => [] });
    // 🔴 Avec son DÉPART DIFFÉRÉ (`startAfter`) : sans lui, l'événement serait traité pendant le balayage de nuit.
    await deps.publierRisqueEleve(T, '33612345678', NEUF_HEURES);
    expect(file.enqueued).toEqual([
      { name: AUTOMATION_EVENT_QUEUE, data: { tenantId: T, event: { kind: 'risque_eleve', waId: '33612345678' } }, opts: { groupId: T, startAfter: NEUF_HEURES } },
    ]);
    // Et le travail de la file le relit tel quel.
    expect(parseAutomationEventJob(file.enqueued[0]!.data)).toEqual({ tenantId: T, event: { kind: 'risque_eleve', waId: '33612345678' } });
  });

  it('il demande les automations `risque_eleve` ACTIVES, et elles seules', async () => {
    const demandes: Array<readonly string[]> = [];
    const deps = depsBalayageRisque({
      pool, file: new FakeQueue(), emetteur: { emettreSignaux: async () => {} },
      automationsActives: async (_t, kinds) => { demandes.push(kinds); return []; },
    });
    expect(await deps.automationRisqueActive(T)).toBe(false);
    expect(demandes).toEqual([['risque_eleve']]);
  });

  it('🔴 les signaux ne coûtent rien tant qu’aucun espace n’a branché d’outil : aucun enfilement', async () => {
    const enfiles: unknown[] = [];
    const emetteur = creerEmetteur({
      destinations: [{ file: 'signaux-test', espacesActifs: async () => new Set<string>() }],
      enfiler: async (_f, job) => { enfiles.push(job); },
    });
    const { deps } = monter(fichesDe(3, DECROCHE, 'moyen'), { emettreSignaux: (t, s) => emetteur.emettreSignaux(t, s) });
    expect((await balayerRisqueEspace(T, deps)).transitions).toBe(3);
    expect(enfiles).toEqual([]);
    // Le témoin : branché, les mêmes transitions partent, en UN job.
    const branche = creerEmetteur({
      destinations: [{ file: 'signaux-test', espacesActifs: async () => new Set([T]) }],
      enfiler: async (_f, job) => { enfiles.push(job); },
    });
    const { deps: deps2 } = monter(fichesDe(3, DECROCHE, 'moyen'), { emettreSignaux: (t, s) => branche.emettreSignaux(t, s) });
    await balayerRisqueEspace(T, deps2);
    expect(enfiles).toHaveLength(1);
  });
});

describe('une fois par nuit', () => {
  const paris = (iso: string) => new Date(iso);

  it('entre 3 h et 6 h, heure de Paris, une seule fois par jour', () => {
    // 2026-09-25 : Paris = UTC+2. 01:00 UTC = 3 h à Paris.
    expect(jourABalayer(paris('2026-09-25T00:59:00.000Z'), null)).toBeNull();
    expect(jourABalayer(paris('2026-09-25T01:00:00.000Z'), null)).toBe('2026-09-25');
    expect(jourABalayer(paris('2026-09-25T03:59:00.000Z'), null)).toBe('2026-09-25');
    expect(jourABalayer(paris('2026-09-25T04:00:00.000Z'), null)).toBeNull();
    expect(jourABalayer(paris('2026-09-25T02:00:00.000Z'), '2026-09-25')).toBeNull();
    expect(jourABalayer(paris('2026-09-26T02:00:00.000Z'), '2026-09-25')).toBe('2026-09-26');
  });

  it('l’heure d’hiver est suivie (Paris = UTC+1)', () => {
    expect(jourABalayer(paris('2026-12-15T02:00:00.000Z'), null)).toBe('2026-12-15');
    expect(jourABalayer(paris('2026-12-15T01:59:00.000Z'), null)).toBeNull();
  });
});
