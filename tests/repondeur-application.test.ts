import { describe, it, expect } from 'vitest';
import { bancDuFil } from './banc-du-fil';
import { modeEffectif } from '../src/repondeur/mode';

/**
 * « MON APPLICATION RÉPOND » (lot 12, livraison B) : un entrant que personne ne tient part vers l'application du client
 * (`conversation.needs_reply`), et le fil reste aux robots, hors d'« À traiter ». Aucun repli si l'application se tait
 * (décision de Julien du 2026-10-08). Sur le VRAI contrôle du fil (`bancDuFil`).
 */
const T = 't1';
const W = '33611223344';
const AD = 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f';
const MSG = 'Bonjour, mon colis ?';
const libre = { conversations: { [W]: { owner: 'app_workflow' as const } } };
const remettre = (b: ReturnType<typeof bancDuFil>, o: { redelivre?: boolean; reactionsSeules?: boolean } = {}) =>
  b.fil.remettreSiPersonneNeSuit(T, W, MSG, { rouverte: false, messageDeclencheur: 'wamid.1', ...o });

describe('le mode `application` dans la remise d’un entrant', () => {
  it('🔴 le message part vers l’adresse désignée ; le fil reste aux robots, l’agent de Meta allumé ne reçoit rien', async () => {
    const b = bancDuFil({ ...libre, mode: 'application', repondeurAdresseId: AD, mbaEnabled: true });
    await remettre(b);
    expect(b.demandesApplication).toEqual([{ waId: W, adresseId: AD, messageDeclencheur: 'wamid.1', contenu: MSG }]);
    expect(b.ecritures).toEqual([]);
    expect(b.etat(W)?.owner).toBe('app_workflow');
    expect(b.appels, 'MBA allumé, en veille : rien').toEqual([]);
    expect(b.demarrages).toEqual([]);
  });

  it('🔴 une adresse qui ne peut pas recevoir (en pause, gelée par l’offre) : à l’équipe, comme le mode « équipe »', async () => {
    const b = bancDuFil({ ...libre, mode: 'application', repondeurAdresseId: AD, demandeApplication: 'indisponible' });
    await remettre(b);
    expect(b.ecritures).toMatchObject([{ owner: 'app_human', opts: { escalade: true } }]);
  });

  it('une panne de la demande : à l’équipe, et l’erreur remonte à l’appelant de la remise (qui la journalise)', async () => {
    const b = bancDuFil({ ...libre, mode: 'application', repondeurAdresseId: AD, demandeApplication: new Error('base indisponible') });
    await expect(remettre(b)).rejects.toThrow('base indisponible');
    expect(b.ecritures).toMatchObject([{ owner: 'app_human' }]);
  });

  it('mêmes gardes qu’un robot : rien pour une redélivrance, une réaction seule, un contact désabonné', async () => {
    for (const o of [{ redelivre: true }, { reactionsSeules: true }]) {
      const b = bancDuFil({ ...libre, mode: 'application', repondeurAdresseId: AD });
      await remettre(b, o);
      expect(b.demandesApplication, JSON.stringify(o)).toEqual([]);
    }
    const stop = bancDuFil({ ...libre, mode: 'application', repondeurAdresseId: AD, desabonnes: [W] });
    await remettre(stop);
    expect(stop.demandesApplication).toEqual([]);
  });

  it('un fil que l’équipe tient lui reste tant que son délai court : l’application n’est pas sollicitée', async () => {
    const b = bancDuFil({ mode: 'application', repondeurAdresseId: AD, conversations: { [W]: { owner: 'app_human', changedAt: new Date() } } });
    await remettre(b);
    expect(b.demandesApplication).toEqual([]);
    expect(b.etat(W)?.owner).toBe('app_human');
  });

  it('🔴 un fil resté à l’agent de Meta revient aux robots avant la demande : la réponse de l’application ne le prendra pas', async () => {
    const b = bancDuFil({ mode: 'application', repondeurAdresseId: AD, conversations: { [W]: { owner: 'mba' } } });
    await remettre(b);
    expect(b.demandesApplication).toHaveLength(1);
    expect(b.etat(W)?.owner).toBe('app_workflow');
  });

  it('🔴 un fil tenu par l’application, mais pas un parcours qui attend la réponse du contact : la réponse API coupe le parcours', async () => {
    const libreFil = bancDuFil({ ...libre, mode: 'application', repondeurAdresseId: AD });
    expect(await libreFil.fil.tenuParLApplication(T, W)).toBe(true);
    const parcours = bancDuFil({ ...libre, mode: 'application', repondeurAdresseId: AD, enAttente: true });
    expect(await parcours.fil.tenuParLApplication(T, W)).toBe(false);
    const equipe = bancDuFil({ mode: 'equipe', conversations: { [W]: { owner: 'app_workflow' as const } } });
    expect(await equipe.fil.tenuParLApplication(T, W)).toBe(false);
  });

  it('l’adresse supprimée (clé étrangère en `set null`) : le mode se lit « équipe »', () => {
    expect(modeEffectif({ mbaEnabled: false, repondeurMode: 'application', repondeurAgentId: null, repondeurWorkflowId: null, repondeurAdresseId: null })).toBe('equipe');
    expect(modeEffectif({ mbaEnabled: false, repondeurMode: 'application', repondeurAgentId: null, repondeurWorkflowId: null, repondeurAdresseId: AD })).toBe('application');
  });
});
