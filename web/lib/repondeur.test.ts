import { describe, it, expect } from 'vitest';
import {
  avertissementAllumageMeta, cibleDisparue, confirmationEteindreMba, confirmationQuitterMba, delaiHeuresDe, lireEtatRepondeur,
  lireRepondeurAgentId, modeEffectifDesReglages, positionGrisee, repondeurAutomatique, type EtatRepondeur,
} from './repondeur';

const fr = (f: string): string => f;

const ETAT: EtatRepondeur = {
  mode: 'agent', modeEffectif: 'agent', agentId: 'ag-lea', workflowId: null, adresseId: null, delaiS: 86400,
  mbaAllume: true, mbaConfigurable: true, modeleDisponible: true,
  agentsActifs: [{ id: 'ag-lea', label: 'Léa' }], scenariosPublies: [{ id: 'wf-1', name: 'Bienvenue' }],
  adressesActives: [{ id: 'ad-1', url: 'https://app.exemple.fr/hooks' }],
};

describe('l’état de « Qui répond au client », vérifié et jamais casté', () => {
  it('une réponse bien formée passe telle quelle', () => {
    expect(lireEtatRepondeur(ETAT)).toEqual(ETAT);
  });

  it('🔴 une réponse illisible (API d’avant RC6, mock `{}`, mode inconnu) : `null`, la carte ne s’affiche pas', () => {
    for (const brut of [null, {}, 'ok', [], { mode: 'robot', modeEffectif: 'equipe' }, { mode: 'agent' }]) {
      expect(lireEtatRepondeur(brut), JSON.stringify(brut)).toBeNull();
    }
  });

  it('les listes écartent une entrée illisible au lieu de faire tomber la carte ; un délai illisible vaut 24 h', () => {
    const e = lireEtatRepondeur({ ...ETAT, delaiS: 'x', agentsActifs: [{ id: 'a', label: 'A' }, { id: 3 }, null], scenariosPublies: 'non' });
    expect(e?.agentsActifs).toEqual([{ id: 'a', label: 'A' }]);
    expect(e?.scenariosPublies).toEqual([]);
    expect(e?.delaiS).toBe(86400);
  });

  it('`repondeurAgentId` de la liste des agents : absent veut dire « on ne sait pas », jamais « aucun »', () => {
    expect(lireRepondeurAgentId('ag1')).toBe('ag1');
    expect(lireRepondeurAgentId(null)).toBeNull();
    expect(lireRepondeurAgentId(undefined)).toBeUndefined();
    expect(lireRepondeurAgentId(3)).toBeUndefined();
  });
});

describe('le mode qui s’applique, lu dans les réglages (miroir de `modeEffectif`)', () => {
  it('🔴 une cible disparue se lit « Équipe » ; l’agent de Meta éteint aussi', () => {
    expect(modeEffectifDesReglages({ mbaEnabled: true, repondeurMode: 'agent', repondeurAgentId: null })).toBe('equipe');
    expect(modeEffectifDesReglages({ mbaEnabled: false, repondeurMode: 'scenario', repondeurWorkflowId: null })).toBe('equipe');
    expect(modeEffectifDesReglages({ mbaEnabled: false, repondeurMode: 'mba' })).toBe('equipe');
    expect(modeEffectifDesReglages({ mbaEnabled: true, repondeurMode: 'scenario', repondeurWorkflowId: 'wf' })).toBe('scenario');
  });

  it('🔴 une API d’avant RC6 (sans `repondeurMode`) : la règle de la reprise, exactement ce qu’elle faisait', () => {
    expect(modeEffectifDesReglages({ mbaEnabled: true })).toBe('mba');
    expect(modeEffectifDesReglages({ mbaEnabled: false, repondeurAgentId: 'ag1' })).toBe('agent');
    expect(modeEffectifDesReglages({ mbaEnabled: false })).toBe('equipe');
  });

  it('🔴 « le répondeur automatique prend la main » mène quelque part dans tous les modes sauf « Équipe »', () => {
    expect(repondeurAutomatique({ mbaEnabled: false, repondeurMode: 'scenario', repondeurWorkflowId: 'wf' })).toBe(true);
    expect(repondeurAutomatique({ mbaEnabled: true, repondeurMode: 'agent', repondeurAgentId: 'ag1' })).toBe(true);
    expect(repondeurAutomatique({ mbaEnabled: true, repondeurMode: 'mba' })).toBe(true);
    // Allumé en veille, mode « Équipe » : personne ne répond automatiquement.
    expect(repondeurAutomatique({ mbaEnabled: true, repondeurMode: 'equipe' })).toBe(false);
    expect(repondeurAutomatique(null)).toBeNull();
    expect(repondeurAutomatique({})).toBeNull();
  });
});

describe('ce que la carte dit', () => {
  it('🔴 une cible disparue est DITE, avec ce qui se passe à la place', () => {
    expect(cibleDisparue({ mode: 'agent', modeEffectif: 'equipe' }, fr)).toBe('L’agent IA choisi a été désactivé ou supprimé : vos messages vont à l’équipe.');
    expect(cibleDisparue({ mode: 'scenario', modeEffectif: 'equipe' }, fr)).toMatch(/scénario choisi a été supprimé/);
    expect(cibleDisparue({ mode: 'mba', modeEffectif: 'equipe' }, fr)).toMatch(/agent de Meta est éteint/);
    expect(cibleDisparue({ mode: 'agent', modeEffectif: 'agent' }, fr)).toBeNull();
    expect(cibleDisparue({ mode: 'application', modeEffectif: 'equipe' }, fr)).toMatch(/adresse de webhook choisie a été supprimée/);
  });

  it('🔴 « Mon application » sur une adresse en pause : le serveur passe tout à l’équipe, et la carte le dit', () => {
    const app = { ...ETAT, mode: 'application' as const, modeEffectif: 'application' as const, adresseId: 'ad-1' };
    expect(cibleDisparue(app, fr)).toBeNull();
    expect(cibleDisparue({ ...app, adressesActives: [] }, fr)).toMatch(/adresse de webhook choisie ne reçoit plus/);
  });

  it('🔴 l’ancienne API (sans `adressesActives`) : aucune adresse, la position « Mon application » est grisée', () => {
    const { adressesActives: _sans, ...ancien } = ETAT;
    const lu = lireEtatRepondeur(ancien);
    expect(lu?.adressesActives).toEqual([]);
    expect(positionGrisee('application', lu!, fr)).toMatchObject({ lien: '/developers/evenements' });
  });

  it('🔴 une position qui ne peut pas répondre est GRISÉE, avec le lien qui la configure', () => {
    expect(positionGrisee('mba', { ...ETAT, mbaConfigurable: false }, fr)).toMatchObject({ lien: '/mba/parametres' });
    expect(positionGrisee('agent', { ...ETAT, agentsActifs: [] }, fr)).toMatchObject({ lien: '/agents', raison: 'Aucun agent IA n’est actif.' });
    expect(positionGrisee('agent', { ...ETAT, modeleDisponible: false }, fr)).toMatchObject({ lien: '/agents' });
    expect(positionGrisee('scenario', { ...ETAT, scenariosPublies: [] }, fr)).toMatchObject({ lien: '/workflows' });
    expect(positionGrisee('application', { ...ETAT, adressesActives: [] }, fr)).toMatchObject({ lien: '/developers/evenements' });
    for (const m of ['mba', 'agent', 'scenario', 'equipe', 'application'] as const) expect(positionGrisee(m, ETAT, fr), m).toBeNull();
  });

  it('les deux confirmations disent ce qui change pour le client', () => {
    expect(confirmationQuitterMba(fr).message).toMatch(/cessera de répondre aux conversations qu’il tient/);
    expect(confirmationEteindreMba(fr).message).toMatch(/iront à l’équipe/);
  });

  it('🔴 allumer l’agent de Meta en mode agent IA ou scénario : il reste en VEILLE, et c’est dit en nommant qui répond', () => {
    expect(avertissementAllumageMeta(ETAT, fr)).toMatch(/^L’agent IA « Léa » répond aujourd’hui au client .* restera en veille/);
    expect(avertissementAllumageMeta({ ...ETAT, modeEffectif: 'scenario', workflowId: 'wf-1' }, fr)).toMatch(/^Le scénario « Bienvenue » répond/);
    expect(avertissementAllumageMeta({ ...ETAT, modeEffectif: 'application' }, fr)).toMatch(/^Votre application répond .* restera en veille/);
    // En « Équipe » il devient le répondeur, en « MBA » il l'est : rien de plus à dire ; illisible non plus.
    expect(avertissementAllumageMeta({ ...ETAT, modeEffectif: 'equipe' }, fr)).toBeNull();
    expect(avertissementAllumageMeta({ ...ETAT, modeEffectif: 'mba' }, fr)).toBeNull();
    expect(avertissementAllumageMeta(null, fr)).toBeNull();
  });

  it('le délai en heures, ramené dans ses bornes', () => {
    expect(delaiHeuresDe(86400)).toBe(24);
    expect(delaiHeuresDe(60)).toBe(1);
    expect(delaiHeuresDe(99 * 86400)).toBe(720);
  });
});
