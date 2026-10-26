import { describe, expect, it } from 'vitest';
import { apresChangementDeLangue, apresEffacement, demandeDuTour, ETAT_INITIAL_FIL, tourDuFil, type EtatSynchroFil } from './fil-synchro';

/**
 * La synchronisation du fil de l'Inbox (`fil-synchro.ts`), sortie de `web/app/inbox/page.tsx` (lot D de l'audit de
 * structure, 2026-10-26). L'e2e de l'Inbox reste, il n'est pas dupliqué : ici, chaque règle du tour, sans React.
 */
type M = { id: string; curseur?: string; corps: string };
const m = (id: string, corps = id, curseur: string | null = `c-${id}`): M => ({ id, corps, ...(curseur ? { curseur } : {}) });
const delta = { cibleLecture: undefined, etaitUnDelta: true };

describe('tourDuFil', () => {
  it('le premier tour pose le curseur sur le dernier message, rend le fil entier, et le marque lu', () => {
    const t = tourDuFil(ETAT_INITIAL_FIL, { messages: [m('1'), m('2')] }, { cibleLecture: undefined, etaitUnDelta: false });
    expect(t.etat.borne).toEqual({ at: 'c-2', id: '2' });
    expect(t.messages!([])).toEqual([m('1'), m('2')]);
    expect(t.marquerLu).toBe(true);
    expect(t.etat.dernierVu).toBe('2');
  });

  it('🔴 rien de nouveau : `prev` rendu TEL QUEL (même référence, le fil reste calme), et pas de « lu » répété', () => {
    const prev = [m('1'), m('2')];
    const etat: EtatSynchroFil = { ...ETAT_INITIAL_FIL, borne: { at: 'c-2', id: '2' }, dernierVu: '2' };
    const vide = tourDuFil(etat, { messages: [] }, delta);
    expect(vide.messages).toBeNull();
    expect(vide.etat.borne).toEqual({ at: 'c-2', id: '2' });
    const deja = tourDuFil(etat, { messages: [m('2')] }, delta);
    expect(deja.messages!(prev)).toBe(prev);
    expect(deja.marquerLu).toBe(false);
  });

  it('🔴 un message déjà affiché n’apparaît jamais deux fois ; seuls les nouveaux s’ajoutent', () => {
    const t = tourDuFil({ ...ETAT_INITIAL_FIL, dernierVu: '2' }, { messages: [m('2'), m('3')] }, delta);
    expect(t.messages!([m('1'), m('2')]).map((x) => x.id)).toEqual(['1', '2', '3']);
    expect(t.marquerLu).toBe(true);
  });

  it('un message sans curseur (serveur plus ancien) : aucun curseur posé, le tour suivant redemande le fil entier', () => {
    const t = tourDuFil({ ...ETAT_INITIAL_FIL, borne: { at: 'c-1', id: '1' } }, { messages: [m('2', '2', null)] }, delta);
    expect(t.etat.borne).toBeNull();
    expect(demandeDuTour(t.etat)).toEqual({});
  });

  it('🔴 un remplacement dû REMPLACE le fil (mêmes identifiants, autre texte), même vide, puis il est consommé', () => {
    const etat = apresChangementDeLangue({ ...ETAT_INITIAL_FIL, borne: { at: 'c-2', id: '2' }, dernierVu: '2' });
    expect(demandeDuTour(etat)).toEqual({});
    const t = tourDuFil(etat, { messages: [m('1', 'uno'), m('2', 'dos')] }, { cibleLecture: 'es', etaitUnDelta: false });
    expect(t.messages!([m('1', 'un'), m('2', 'deux')]).map((x) => x.corps)).toEqual(['uno', 'dos']);
    expect(t.etat.remplacerAuProchain).toBe(false);
    const videDu = tourDuFil<M>(apresChangementDeLangue(ETAT_INITIAL_FIL), { messages: [] }, { cibleLecture: 'es', etaitUnDelta: false });
    expect(videDu.messages!([m('1')])).toEqual([]);
  });

  it('🔴 la traduction redevient possible après un DELTA : le prochain tour reprend le fil entier et le remplace', () => {
    const etat: EtatSynchroFil = { ...ETAT_INITIAL_FIL, borne: { at: 'c-2', id: '2' }, traductionIndisponible: true };
    const t = tourDuFil(etat, { messages: [m('3')], traductionIndisponible: false }, { cibleLecture: 'fr', etaitUnDelta: true });
    expect(t.etat).toMatchObject({ borne: null, remplacerAuProchain: true, traductionIndisponible: false });
  });

  it('🔴 … mais pas après un fil ENTIER (déjà traduit : le redemander paierait deux fois), ni sans langue de lecture', () => {
    const etat: EtatSynchroFil = { ...ETAT_INITIAL_FIL, traductionIndisponible: true };
    const entier = tourDuFil(etat, { messages: [m('1')], traductionIndisponible: false }, { cibleLecture: 'fr', etaitUnDelta: false });
    expect(entier.etat).toMatchObject({ borne: { at: 'c-1', id: '1' }, remplacerAuProchain: false });
    const sansLangue = tourDuFil(etat, { messages: [m('1')] }, { cibleLecture: undefined, etaitUnDelta: true });
    expect(sansLangue.etat.remplacerAuProchain).toBe(false);
  });

  it('la traduction toujours indisponible : rien n’est redemandé, l’état le retient pour le tour suivant', () => {
    const t = tourDuFil({ ...ETAT_INITIAL_FIL, traductionIndisponible: true }, { messages: [], traductionIndisponible: true }, { cibleLecture: 'fr', etaitUnDelta: true });
    expect(t.etat).toMatchObject({ remplacerAuProchain: false, traductionIndisponible: true });
  });
});

describe('apresEffacement', () => {
  it('relâche le curseur (le delta ne repart pas d’un message qui n’existe plus), et garde le reste', () => {
    const etat: EtatSynchroFil = { borne: { at: 'c-2', id: '2' }, remplacerAuProchain: false, traductionIndisponible: true, dernierVu: '2' };
    expect(apresEffacement(etat)).toEqual({ ...etat, borne: null });
  });
});
