import { describe, it, expect } from 'vitest';
import { runRetrySweep, type RetrySweepDeps } from '../src/campaign/retry-sweep';
import type { AutoRetryRecipient, CandidatBascule } from '../src/campaign/store.pg';
import type { Etage } from '../src/campaign/etages';

const R = (id: string, campaignId = `c-${id}`): AutoRetryRecipient => ({
  id, campaignId, tenantId: `t-${id}`, contactId: `ct-${id}`, toE164: `+3360${id}`,
  // Défaut de la migration 0134 : la campagne REFUSE de rattraper hors horaires. Les huit cas
  // historiques ci-dessous posent donc tous la question à `fenetreOuverte`, dont le défaut du gabarit
  // répond « ouvert » : leur comportement est rigoureusement celui d'avant.
  rattrapageHorsHoraires: false,
});

/** Un candidat à la bascule : le destinataire de `R`, plus tout ce que la règle demande. */
const CHAINE_2: Etage[] = [{ rang: 1, canal: 'whatsapp' }, { rang: 2, canal: 'rcs' }];
const C = (id: string, over: Partial<CandidatBascule> = {}): CandidatBascule => ({
  ...R(id), codeErreur: 131026, chaine: CHAINE_2, rangCourant: 1, reessayer: true, dejaReessaye: false,
  emailDuContact: null, ...over,
});

function deps(over: Partial<RetrySweepDeps> = {}): {
  d: RetrySweepDeps; enqueued: string[]; reset: string[]; flagged: Array<[string, string]>; marked: string[];
  notes: Array<[string, string, boolean]>; bascules: Array<[string, number]>;
} {
  const enqueued: string[] = [];
  const reset: string[] = [];
  const flagged: Array<[string, string]> = [];
  const marked: string[] = [];
  const notes: Array<[string, string, boolean]> = [];
  const bascules: Array<[string, number]> = [];
  const d: RetrySweepDeps = {
    isMorningWindow: () => true,
    list131049: async () => [],
    list131026: async () => [],
    list131026SecondFail: async () => [],
    resetForRetry: async (id) => { reset.push(id); return true; },
    markUnreachableDone: async (id) => { marked.push(id); return true; },
    enqueueRun: async (id) => { enqueued.push(id); },
    flagUnreachable: async (tenantId, e164) => { flagged.push([tenantId, e164]); },
    noterJoignabilite: async (tenantId, contactId, joignable) => { notes.push([tenantId, contactId, joignable]); },
    fenetreOuverte: async () => true,
    listCandidatsBascule: async () => [],
    basculerEtage: async (id, rang) => { bascules.push([id, rang]); return true; },
    ...over,
  };
  return { d, enqueued, reset, flagged, marked, notes, bascules };
}

describe('runRetrySweep (F6)', () => {
  it('131049 : relancé (reset + enqueue) SEULEMENT en fenêtre matinale', async () => {
    const morning = deps({ isMorningWindow: () => true, list131049: async () => [R('1')] });
    expect(await runRetrySweep(morning.d)).toMatchObject({ retried: 1 });
    expect(morning.reset).toEqual(['1']);
    expect(morning.enqueued).toEqual(['c-1']);

    const night = deps({ isMorningWindow: () => false, list131049: async () => [R('1')] });
    const res = await runRetrySweep(night.d);
    expect(res.retried).toBe(0);
    expect(night.reset).toEqual([]); // hors fenêtre : pas de relance 131049
  });

  it('131026 : relancé une fois (reset + enqueue), quelle que soit l\'heure', async () => {
    const d = deps({ isMorningWindow: () => false, list131026: async () => [R('a'), R('b')] });
    expect((await runRetrySweep(d.d)).retried).toBe(2);
    expect(d.reset).toEqual(['a', 'b']);
    expect(d.enqueued).toEqual(['c-a', 'c-b']);
  });

  it('131026 2e échec : flag injoignable PUIS note PUIS markUnreachableDone (dans cet ordre)', async () => {
    const order: string[] = [];
    const d = deps({
      list131026SecondFail: async () => [R('z')],
      flagUnreachable: async () => { order.push('flag'); },
      noterJoignabilite: async () => { order.push('note'); },
      markUnreachableDone: async (id) => { order.push(`mark:${id}`); return true; },
    });
    expect((await runRetrySweep(d.d)).flagged).toBe(1);
    // 🔴 LA CLÔTURE EST LA DERNIÈRE : tant qu'elle n'est pas passée, le destinataire reste listé, donc un
    // échec de l'une des deux écritures d'avant ne perd rien. Noter APRÈS elle perdrait le verdict pour
    // toujours, le destinataire n'étant plus jamais relisté.
    expect(order).toEqual(['flag', 'note', 'mark:z']);
  });

  it('131026 2e échec : le verdict est écrit CHEZ NOUS, sur le contact, et il vaut false', async () => {
    const d = deps({ list131026SecondFail: async () => [R('z')] });
    expect((await runRetrySweep(d.d)).flagged).toBe(1);
    // Le contact, pas le destinataire : la mémoire vit sur `contacts`, et elle sert au-delà de cette campagne.
    expect(d.notes).toEqual([['t-z', 'ct-z', false]]);
  });

  it('noterJoignabilite qui throw -> PAS de markUnreachableDone (réessayé au tour suivant)', async () => {
    const d = deps({
      list131026SecondFail: async () => [R('z')],
      noterJoignabilite: async () => { throw new Error('base injoignable'); },
    });
    const res = await runRetrySweep(d.d);
    expect(res.flagged).toBe(0);
    expect(d.marked).toEqual([]);
  });

  it('flagUnreachable qui throw -> PAS de markUnreachableDone (réessayé au tour suivant)', async () => {
    const d = deps({
      list131026SecondFail: async () => [R('z')],
      flagUnreachable: async () => { throw new Error('connecteur down'); },
    });
    const res = await runRetrySweep(d.d);
    expect(res.flagged).toBe(0);
    expect(d.marked).toEqual([]); // pas marqué : on ne clôt pas sur un flag échoué
    expect(d.notes).toEqual([]); // et rien n'est noté : la note vient APRÈS le flag
  });

  it('resetForRetry qui renvoie false (conflit) -> pas d\'enqueue', async () => {
    const d = deps({ list131026: async () => [R('a')], resetForRetry: async () => false });
    expect((await runRetrySweep(d.d)).retried).toBe(0);
    expect(d.enqueued).toEqual([]);
  });

  it('un échec par destinataire n\'interrompt pas le balayage', async () => {
    const d = deps({
      list131026: async () => [R('a'), R('b')],
      resetForRetry: async (id) => { if (id === 'a') throw new Error('boom'); return true; },
    });
    // 'a' throw, mais 'b' est quand même traité.
    expect((await runRetrySweep(d.d)).retried).toBe(1);
    expect(d.enqueued).toEqual(['c-b']);
  });
});

/**
 * LA BASCULE D'ÉTAGE, la passe des campagnes à REPLI.
 *
 * ⚠️ Les huit cas ci-dessus sont ceux des campagnes SANS repli, et ils restent VERBATIM : la politique
 * de réessai de F6 n'est pas remplacée, elle est bornée aux campagnes qui n'ont pas de chaîne. La
 * frontière est posée en SQL (`SANS_REPLI_SQL`), donc invisible d'un test qui injecte ses listes ; ce
 * que ces tests-ci vérifient, c'est ce que le balayage FAIT d'un candidat, pas qui lui arrive.
 */
describe('runRetrySweep : la bascule d\'étage', () => {
  it('un candidat qui a un etage suivant bascule et son run est reenfile', async () => {
    const d = deps({ listCandidatsBascule: async () => [C('a')] });
    const res = await runRetrySweep(d.d);
    expect(res.bascules).toBe(1);
    expect(d.bascules).toEqual([['a', 2]]);
    expect(d.enqueued).toEqual(['c-a']);
    // 🔴 ET SURTOUT PAS DE RÉESSAI : une bascule ne consomme pas le budget de réessai, et `resetForRetry`
    // remettrait le destinataire sur l'étage qui vient d'échouer.
    expect(d.reset).toEqual([]);
  });

  it('au dernier etage, le balayage ne fait RIEN : ni bascule, ni reessai, ni cloture', async () => {
    const d = deps({ listCandidatsBascule: async () => [C('z', { rangCourant: 2 })] });
    const res = await runRetrySweep(d.d);
    expect(res.bascules).toBe(0);
    // « Terminal » se joue en ne faisant rien : le destinataire reste `failed`, plus personne ne le reprend.
    expect(d.bascules).toEqual([]);
    expect(d.enqueued).toEqual([]);
    expect(d.reset).toEqual([]);
    expect(d.marked).toEqual([]);
  });

  it('basculerEtage qui rend false (concurrence) -> pas d enqueue', async () => {
    // Un autre balayage a déjà fait avancer ce destinataire : le verrou `etage_courant < $2` refuse
    // l'écriture, et on ne doit surtout pas enfiler un second run pour le même échec.
    const d = deps({ listCandidatsBascule: async () => [C('a')], basculerEtage: async () => false });
    const res = await runRetrySweep(d.d);
    expect(res.bascules).toBe(0);
    expect(d.enqueued).toEqual([]);
  });

  it('un echec par candidat n interrompt pas la passe', async () => {
    const d = deps({
      listCandidatsBascule: async () => [C('a'), C('b')],
      basculerEtage: async (id, rang) => { if (id === 'a') throw new Error('boom'); return (d.bascules.push([id, rang]), true); },
    });
    expect((await runRetrySweep(d.d)).bascules).toBe(1);
    expect(d.enqueued).toEqual(['c-b']);
  });

  it('la bascule ne desactive PAS les relances de F6 (les deux passes coexistent dans le meme tour)', async () => {
    // Deux campagnes différentes, l'une à repli, l'autre sans : le balayage sert les deux d'un tour.
    const d = deps({ listCandidatsBascule: async () => [C('a')], list131026: async () => [R('s')] });
    const res = await runRetrySweep(d.d);
    expect(res.bascules).toBe(1);
    expect(res.retried).toBe(1);
    expect(d.bascules).toEqual([['a', 2]]);
    expect(d.reset).toEqual(['s']);
  });

  it('la chaine trouee : le balayage transporte le rang que la REGLE rend, pas rangCourant + 1', async () => {
    // 🔴 C'est ce que la passe doit propager jusqu'à l'écriture. Un jeu `[1, 2]` ne l'aurait pas montré.
    const TROUEE: Etage[] = [{ rang: 1, canal: 'whatsapp' }, { rang: 3, canal: 'email' }];
    // ⚠️ `emailDuContact` FOURNI : le canal de remplissage de ce jeu est `email`, et depuis le
    // 2026-09-12 un étage e-mail sans adresse est SAUTÉ. Sans cette adresse, le cas n'exercerait plus
    // l'arithmétique des rangs, qui est sa seule raison d'être.
    const d = deps({ listCandidatsBascule: async () => [C('a', { chaine: TROUEE, emailDuContact: 'a@b.fr' })] });
    expect((await runRetrySweep(d.d)).bascules).toBe(1);
    expect(d.bascules).toEqual([['a', 3]]);
  });
});
