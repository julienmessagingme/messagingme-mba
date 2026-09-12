import { describe, it, expect } from 'vitest';
import { runRetrySweep, type RetrySweepDeps } from '../src/campaign/retry-sweep';
import type { AutoRetryRecipient, CandidatBascule } from '../src/campaign/store.pg';
import { fenetreDeRattrapageOuverte } from '../src/lib/heures-ouvrees';
import type { BusinessHours } from '../src/workflow/conditions';

/**
 * L'HORAIRE DU RATTRAPAGE, DISTINCT DE CELUI DE L'ENVOI INITIAL.
 *
 * 🔴 DEUX RÉGLAGES COHABITENT ET NE SE CONFONDENT PAS. `business_hours_only` gouverne l'envoi initial,
 * le moment que l'opérateur CHOISIT en lançant sa campagne, et il est appliqué par le MOTEUR
 * (`engine.ts`, migration 0122, avec mise en pause et reprise). `rattrapage_hors_horaires` gouverne le
 * réessai et le repli, le moment que PERSONNE ne choisit, et il est appliqué par le BALAYAGE.
 *
 * ⚠️ Pas de mise en pause de la campagne pour le rattrapage : elle peut être TERMINÉE depuis longtemps
 * quand un rattrapage se présente, et une campagne terminée ne se met pas en pause. Le balayage teste
 * la fenêtre avant de ré-enfiler et ne fait rien sinon, exactement comme `isMorningWindow()`.
 */

const R = (id: string, horsHoraires = false): AutoRetryRecipient => ({
  id, campaignId: `c-${id}`, tenantId: `t-${id}`, contactId: `ct-${id}`, toE164: `+3360${id}`,
  rattrapageHorsHoraires: horsHoraires,
});

const C = (id: string, horsHoraires = false): CandidatBascule => ({
  ...R(id, horsHoraires),
  codeErreur: 131026, chaine: [{ rang: 1, canal: 'whatsapp' }, { rang: 2, canal: 'rcs' }],
  rangCourant: 1, reessayer: true, dejaReessaye: false, emailDuContact: null,
});

function deps(over: Partial<RetrySweepDeps> = {}): {
  d: RetrySweepDeps; enqueued: string[]; reset: string[]; bascules: Array<[string, number]>; fenetres: string[];
} {
  const enqueued: string[] = [];
  const reset: string[] = [];
  const bascules: Array<[string, number]> = [];
  const fenetres: string[] = [];
  const d: RetrySweepDeps = {
    isMorningWindow: () => true,
    list131049: async () => [],
    list131026: async () => [],
    list131026SecondFail: async () => [],
    resetForRetry: async (id) => { reset.push(id); return true; },
    markUnreachableDone: async () => true,
    enqueueRun: async (id) => { enqueued.push(id); },
    flagUnreachable: async () => {},
    noterJoignabilite: async () => {},
    listCandidatsBascule: async () => [],
    basculerEtage: async (id, rang) => { bascules.push([id, rang]); return true; },
    // Il est 22 h, l'espace est fermé : c'est l'état par défaut de ce fichier, celui qui met la garde
    // à l'épreuve. Les cas qui veulent la journée le disent explicitement.
    fenetreOuverte: async (t) => { fenetres.push(t); return false; },
    ...over,
  };
  return { d, enqueued, reset, bascules, fenetres };
}

describe('le rattrapage hors horaires : le RÉESSAI', () => {
  it('rattrapage hors horaires interdit et il est 22h : le destinataire est TOUJOURS LA au tour suivant', async () => {
    const listes = [R('a')];
    const d = deps({ list131026: async () => listes });
    const res = await runRetrySweep(d.d);
    expect(res.retried).toBe(0);
    // 🔴 NE PAS se contenter de vérifier qu'il n'est pas parti : un destinataire PERDU passerait aussi
    // ce test. On vérifie qu'il est encore réclamable, c'est-à-dire que RIEN n'a été écrit sur lui :
    // ni remise en `pending` (`resetForRetry`), ni enfilement. Il reste donc `failed`, donc listé.
    expect(d.reset).toEqual([]);
    expect(d.enqueued).toEqual([]);
    expect(await d.d.list131026()).toHaveLength(1);
  });

  it('rattrapage hors horaires autorise et il est 22h : il part', async () => {
    const d = deps({ list131026: async () => [R('a', true)] });
    const res = await runRetrySweep(d.d);
    expect(res.retried).toBe(1);
    expect(d.enqueued).toEqual(['c-a']);
    // ⚠️ La campagne qui s'affranchit des horaires ne pose même pas la question : aucune lecture des
    // réglages de l'espace pour elle.
    expect(d.fenetres).toEqual([]);
  });

  it('un espace sans heures d ouverture rattrape quand meme', async () => {
    // « Sans heures » veut dire « aucun jour ouvert de la semaine » : il n'y a alors pas de prochaine
    // ouverture à attendre, donc attendre reviendrait à ne jamais rattraper. `fenetreOuverte` rend
    // `true` dans ce cas (cf. `fenetreDeRattrapageOuverte`, vérifié plus bas sur les vrais horaires).
    const d = deps({ list131026: async () => [R('a')], fenetreOuverte: async () => true });
    expect((await runRetrySweep(d.d)).retried).toBe(1);
  });

  it('131049 aussi : la fenetre matinale ne suffit pas, l espace doit etre ouvert', async () => {
    // 🔴 LES DEUX GARDES SE CUMULENT, elles ne se remplacent pas. `isMorningWindow` dit « c'est le bon
    // moment de la journée pour retenter un plafond marketing », la fenêtre d'ouverture dit « l'espace
    // accepte qu'on écrive à ses contacts maintenant ». Un matin de jour férié, la première est vraie
    // et la seconde fausse.
    const d = deps({ isMorningWindow: () => true, list131049: async () => [R('a')] });
    expect((await runRetrySweep(d.d)).retried).toBe(0);
    expect(d.reset).toEqual([]);
  });

  it('la cloture en injoignable n est PAS gardee : elle n envoie rien', async () => {
    // Elle écrit un constat et clôt. La soumettre à la fenêtre repousserait au lendemain une écriture
    // que personne ne reçoit, et un espace fermé sept jours sur sept ne clôturerait jamais rien.
    let flagged = 0;
    const d = deps({ list131026SecondFail: async () => [R('z')], flagUnreachable: async () => { flagged += 1; } });
    expect((await runRetrySweep(d.d)).flagged).toBe(1);
    expect(flagged).toBe(1);
  });

  it('la fenetre est lue UNE fois par espace et par tour, pas une fois par destinataire', async () => {
    // Trois destinataires du même espace, une seule lecture des réglages : la garde ne doit pas
    // transformer un balayage de 500 destinataires en 500 lectures de `tenant_settings`.
    const memeEspace = (id: string): AutoRetryRecipient => ({ ...R(id), tenantId: 't-commun' });
    const d = deps({ list131026: async () => [memeEspace('a'), memeEspace('b'), memeEspace('c')] });
    await runRetrySweep(d.d);
    expect(d.fenetres).toEqual(['t-commun']);
  });

  it('une fenetre illisible fait sauter le tour, elle ne fait pas partir (echec FERME)', async () => {
    // ⚠️ À L'INVERSE du moteur, qui traite une lecture ratée des horaires comme « aucune contrainte » :
    // là-bas un opérateur vient de cliquer « envoyer », ici personne n'attend rien à la seconde. Le
    // destinataire reste en échec et le tour suivant arrive dans quelques minutes.
    const d = deps({
      list131026: async () => [R('a')],
      fenetreOuverte: async () => { throw new Error('reglages illisibles'); },
    });
    expect((await runRetrySweep(d.d)).retried).toBe(0);
    expect(d.reset).toEqual([]);
  });
});

describe('le rattrapage hors horaires : le REPLI', () => {
  it('la bascule d etage passe par la MEME garde que le reessai', async () => {
    const d = deps({ listCandidatsBascule: async () => [C('a')] });
    expect((await runRetrySweep(d.d)).bascules).toBe(0);
    // 🔴 Et RIEN n'est écrit : basculer puis ne pas enfiler laisserait le destinataire `pending` sur le
    // nouvel étage, donc invisible de toute liste d'échec, donc jamais envoyé et jamais rattrapé.
    expect(d.bascules).toEqual([]);
    expect(d.enqueued).toEqual([]);
  });

  it('une campagne qui autorise le rattrapage hors horaires bascule la nuit', async () => {
    const d = deps({ listCandidatsBascule: async () => [C('a', true)] });
    expect((await runRetrySweep(d.d)).bascules).toBe(1);
    expect(d.bascules).toEqual([['a', 2]]);
  });

  it('deux campagnes du meme espace, deux reglages : chacune la sienne', async () => {
    // 🔴 LE RÉGLAGE VOYAGE AVEC LE DESTINATAIRE, PAS AVEC LE BALAYAGE. Un tour sert les destinataires de
    // plusieurs campagnes : un drapeau posé sur le balayage rendrait le réglage de l'une opposable à
    // toutes les autres.
    const d = deps({ listCandidatsBascule: async () => [C('non'), C('oui', true)] });
    expect((await runRetrySweep(d.d)).bascules).toBe(1);
    expect(d.bascules).toEqual([['oui', 2]]);
  });
});

/**
 * 🔴 LA COMBINAISON QUI PROUVE QUE LA SÉPARATION EST RÉELLE ET PAS DÉCORATIVE.
 *
 * Deux réglages distincts qui donnent toujours la même réponse seraient un seul réglage déguisé. Le cas
 * qui les sépare est celui-ci : une campagne qui ENVOIE la nuit (`business_hours_only = false`, donc le
 * moteur ne l'arrête jamais) et qui REFUSE de rattraper la nuit (`rattrapage_hors_horaires = false`).
 */
describe('les deux reglages sont independants', () => {
  it('une campagne qui envoie la nuit peut refuser de rattraper la nuit', async () => {
    // `business_hours_only = false` : le moteur n'a posé AUCUNE garde sur l'envoi initial, et ça se voit
    // au fait que ce réglage n'apparaît nulle part dans les dépendances du balayage. Le rattrapage,
    // lui, est gardé.
    const d = deps({ list131026: async () => [R('a')], listCandidatsBascule: async () => [C('b')] });
    const res = await runRetrySweep(d.d);
    expect(res.retried).toBe(0);
    expect(res.bascules).toBe(0);
  });

  it('et l inverse : une campagne en heures ouvrees peut rattraper la nuit', async () => {
    // Le symétrique, qui est le plus contre-intuitif des deux : l'envoi initial n'est parti que le jour,
    // et pourtant le rattrapage d'un échec part la nuit, parce que c'est ce que le client a demandé.
    const d = deps({ list131026: async () => [R('a', true)], listCandidatsBascule: async () => [C('b', true)] });
    const res = await runRetrySweep(d.d);
    expect(res.retried).toBe(1);
    expect(res.bascules).toBe(1);
  });
});

/**
 * La fenêtre elle-même, sur de vrais horaires. ⚠️ C'est la pièce que le balayage ne peut PAS tester :
 * il la reçoit en dépendance, donc il croit toujours ce qu'elle dit.
 */
describe('fenetreDeRattrapageOuverte', () => {
  const OUVRE_9_18: BusinessHours = {
    '0': { closed: true, open: '', close: '' },
    '1': { closed: false, open: '09:00', close: '18:00' },
    '2': { closed: false, open: '09:00', close: '18:00' },
    '3': { closed: false, open: '09:00', close: '18:00' },
    '4': { closed: false, open: '09:00', close: '18:00' },
    '5': { closed: false, open: '09:00', close: '18:00' },
    '6': { closed: true, open: '', close: '' },
  };
  // Les sept jours fermés : la configuration qui n'a pas de « prochaine ouverture ».
  const TOUT_FERME: BusinessHours = Object.fromEntries(
    ['0', '1', '2', '3', '4', '5', '6'].map((j) => [j, { closed: true, open: '', close: '' }]),
  );
  // Mardi 8 septembre 2026, heure de Paris (UTC+2 en septembre).
  const MARDI_14H = new Date('2026-09-08T12:00:00.000Z');
  const MARDI_22H = new Date('2026-09-08T20:00:00.000Z');
  const DIMANCHE_14H = new Date('2026-09-06T12:00:00.000Z');

  it('en pleine journee ouvree : ouvert', () => {
    expect(fenetreDeRattrapageOuverte(MARDI_14H, 'Europe/Paris', OUVRE_9_18)).toBe(true);
  });
  it('a 22h un jour ouvre : ferme, il y a une ouverture a attendre', () => {
    expect(fenetreDeRattrapageOuverte(MARDI_22H, 'Europe/Paris', OUVRE_9_18)).toBe(false);
  });
  it('un dimanche : ferme, le lundi arrive', () => {
    expect(fenetreDeRattrapageOuverte(DIMANCHE_14H, 'Europe/Paris', OUVRE_9_18)).toBe(false);
  });
  it('sept jours fermes : OUVERT, parce qu il n y a rien a attendre', () => {
    // 🔴 Le cas qui, traité comme « fermé », gèlerait tous les rattrapages de cet espace POUR TOUJOURS,
    // sans message d'erreur et sans que personne ne puisse le voir.
    expect(fenetreDeRattrapageOuverte(MARDI_14H, 'Europe/Paris', TOUT_FERME)).toBe(true);
    expect(fenetreDeRattrapageOuverte(MARDI_22H, 'Europe/Paris', TOUT_FERME)).toBe(true);
  });
  it('le fuseau compte : 22h a Paris, c est encore l apres-midi a New York', () => {
    // ⚠️ Une fenêtre calculée sur l'heure du serveur au lieu de celle de l'espace se tromperait ici, et
    // seulement pendant quelques heures par jour : le genre de défaut qu'on ne voit jamais en test.
    expect(fenetreDeRattrapageOuverte(MARDI_22H, 'America/New_York', OUVRE_9_18)).toBe(true);
  });
});
