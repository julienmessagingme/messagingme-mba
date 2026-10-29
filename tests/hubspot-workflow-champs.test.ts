import { describe, it, expect } from 'vitest';
import { CHAMPS_FICHE_HUBSPOT, champsDeFiche, declarerChampsHubspot } from '../src/hubspot-workflow/champs';
import type { UserFieldDef } from '../src/crm/types';

/**
 * LES CHAMPS DE L'ACTION TRANSACTION (cadrage du 2026-10-29, décisions 6 et 7). 🔴 Des clés FIXES : une clé tirée du
 * libellé (« Prénom (HubSpot) » donnerait `prenom_hubspot`) ferait pointer les sources du modèle sur un champ que l'action
 * n'écrit pas.
 */
describe('les champs que l’action transaction écrit sur la fiche', () => {
  const store = () => {
    const defs: UserFieldDef[] = [];
    return { defs, list: async () => [...defs], upsert: async (_t: string, d: UserFieldDef) => { defs.push(d); } };
  };

  it('🔴 déclarés sous leurs clés fixes, une fois, le lien en type url', async () => {
    const s = store();
    await declarerChampsHubspot(s, 't1');
    await declarerChampsHubspot(s, 't1');
    expect(s.defs).toEqual([
      { key: 'hubspot_prenom', label: 'Prénom (HubSpot)', type: 'text' },
      { key: 'hubspot_conseiller', label: 'Conseiller (HubSpot)', type: 'text' },
      { key: 'hubspot_lien_agenda', label: 'Lien d’agenda (HubSpot)', type: 'url' },
    ]);
  });

  it('une clé que le client a déjà est reprise telle quelle', async () => {
    const s = store();
    s.defs.push({ key: 'hubspot_prenom', label: 'Prénom HubSpot', type: 'text' });
    await declarerChampsHubspot(s, 't1');
    expect(s.defs.filter((d) => d.key === 'hubspot_prenom')).toEqual([{ key: 'hubspot_prenom', label: 'Prénom HubSpot', type: 'text' }]);
    expect(s.defs).toHaveLength(CHAMPS_FICHE_HUBSPOT.length);
  });

  it('🔴 une valeur posée, une absente ou vide RETIRÉE (jamais la valeur d’une transaction précédente)', () => {
    expect(champsDeFiche({ prenom: 'Claire', conseiller: '', lienAgenda: 'https://meetings-eu1.hubspot.com/x' })).toEqual({
      poser: { hubspot_prenom: 'Claire', hubspot_lien_agenda: 'https://meetings-eu1.hubspot.com/x' },
      retirer: ['hubspot_conseiller'],
    });
    expect(champsDeFiche({})).toEqual({ poser: {}, retirer: ['hubspot_prenom', 'hubspot_conseiller', 'hubspot_lien_agenda'] });
  });
});
