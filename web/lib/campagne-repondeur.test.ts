import { describe, it, expect } from 'vitest';
import {
  choixIndisponible, choixParDefaut, lireChoixRepondeur, optionsDuRepondeur, repondeurAEnvoyer, repondeurPossible,
  type SourcesRepondeur,
} from './campagne-repondeur';
import type { EtatRepondeur } from './repondeur';

const t = (fr: string): string => fr;
const AG = '11111111-2222-4333-8444-555555555555';

const etat = (o: Partial<EtatRepondeur> = {}): EtatRepondeur => ({
  mode: 'equipe', modeEffectif: 'equipe', agentId: null, workflowId: null, adresseId: null, delaiS: 3600,
  mbaAllume: true, mbaConfigurable: true, modeleDisponible: true,
  agentsActifs: [{ id: AG, label: 'Léa' }], scenariosPublies: [], adressesActives: [],
  ...o,
});
const sources = (o: Partial<SourcesRepondeur> = {}): SourcesRepondeur => ({ etat: etat(), agentMetaDansLOffre: true, espaceAutomatique: false, ...o });

describe('les répondeurs proposés à un étage de campagne (2026-10-30)', () => {
  it('dans l’ordre décidé : le répondeur de l’espace, l’agent de Meta, puis chaque agent IA actif', () => {
    const options = optionsDuRepondeur(sources({ etat: etat({ modeEffectif: 'agent', mode: 'agent' }) }), t);
    expect(options.map((o) => o.valeur)).toEqual(['espace', 'mba', `agent:${AG}`]);
    expect(options.map((o) => o.libelle)).toEqual(['Le répondeur de l’espace : Un agent IA', 'L’agent de Meta (MBA)', 'L’agent IA « Léa »']);
    expect(options.every((o) => o.raison === null)).toBe(true);
  });

  it('🔴 en mode « Équipe », le répondeur de l’espace est grisé avec sa raison, les autres restent choisissables', () => {
    const options = optionsDuRepondeur(sources(), t);
    expect(options[0]!.raison).toMatch(/personne ne répond automatiquement/);
    expect(repondeurPossible(options)).toBe(true);
    expect(choixParDefaut(undefined, options)).toBe('mba');
  });

  it('🔴 l’agent de Meta grisé : pas configuré, hors de l’offre, éteint (l’allumage lu est brut, l’offre se lit à part)', () => {
    const raison = (o: Partial<SourcesRepondeur>) => optionsDuRepondeur(sources(o), t).find((x) => x.valeur === 'mba')!.raison;
    expect(raison({ etat: etat({ mbaConfigurable: false }) })).toMatch(/pas encore configuré/);
    expect(raison({ agentMetaDansLOffre: false })).toMatch(/offre ne comprend pas/);
    expect(raison({ etat: etat({ mbaAllume: false }) })).toMatch(/éteint/);
    expect(raison({ agentMetaDansLOffre: null }), 'offre inconnue : rien de grisé pour elle').toBeNull();
    // 🔴 Ce que le serveur rend VRAIMENT hors de l'offre : `mbaConfigurable` faux aussi. La raison dite est l'offre.
    expect(raison({ agentMetaDansLOffre: false, etat: etat({ mbaConfigurable: false }) })).toMatch(/offre ne comprend pas/);
  });

  it('les agents IA grisés quand le modèle manque sur l’instance ; aucun agent actif, aucune entrée d’agent', () => {
    expect(optionsDuRepondeur(sources({ etat: etat({ modeleDisponible: false }) }), t).at(-1)!.raison).toMatch(/ne peuvent pas répondre/);
    expect(optionsDuRepondeur(sources({ etat: etat({ agentsActifs: [] }) }), t).map((o) => o.valeur)).toEqual(['espace', 'mba']);
  });

  it('🔴 rien de configuré (Accueil en « Équipe », agent de Meta éteint, aucun agent) : le choix entier se grise', () => {
    const options = optionsDuRepondeur(sources({ etat: etat({ mbaAllume: false, agentsActifs: [] }) }), t);
    expect(repondeurPossible(options)).toBe(false);
    expect(choixParDefaut(undefined, options)).toBeNull();
  });

  it('réglages illisibles : seul le répondeur de l’espace, jugé comme avant (`repondeurAutomatique`)', () => {
    expect(optionsDuRepondeur(sources({ etat: null, espaceAutomatique: true }), t)).toEqual([{ valeur: 'espace', libelle: 'Le répondeur de l’espace', raison: null }]);
    expect(repondeurPossible(optionsDuRepondeur(sources({ etat: null, espaceAutomatique: false }), t))).toBe(false);
  });

  it('le choix de l’étage est gardé s’il reste choisissable ; devenu indisponible, l’écran le dit', () => {
    const options = optionsDuRepondeur(sources({ etat: etat({ modeEffectif: 'mba', mode: 'mba' }) }), t);
    expect(choixParDefaut(`agent:${AG}`, options)).toBe(`agent:${AG}`);
    expect(choixParDefaut(undefined, options)).toBe('espace');
    expect(choixIndisponible(`agent:${AG}`, options)).toBe(false);
    const sansAgent = optionsDuRepondeur(sources({ etat: etat({ agentsActifs: [] }) }), t);
    expect(choixIndisponible(`agent:${AG}`, sansAgent)).toBe(true);
    expect(choixIndisponible(undefined, sansAgent), 'le répondeur de l’espace, en mode « Équipe »').toBe(true);
  });
});

describe('ce que l’étage envoie au serveur', () => {
  it('🔴 rien pour le répondeur de l’espace, un étage à scénario ou un étage qui renvoie à l’équipe', () => {
    expect(repondeurAEnvoyer({ formule: 'seul', devenir: 'mba' }, 'whatsapp')).toEqual({});
    expect(repondeurAEnvoyer({ formule: 'seul', devenir: 'mba', repondeur: 'espace' }, 'whatsapp')).toEqual({});
    expect(repondeurAEnvoyer({ formule: 'avec_scenario', devenir: 'mba', repondeur: 'mba' }, 'whatsapp')).toEqual({});
    expect(repondeurAEnvoyer({ formule: 'seul', devenir: 'inbox', repondeur: `agent:${AG}` }, 'whatsapp')).toEqual({});
    expect(repondeurAEnvoyer(undefined, 'whatsapp')).toEqual({});
    // 🔴 Hors WhatsApp, rien : une réponse RCS ou e-mail ne passe jamais par la remise.
    expect(repondeurAEnvoyer({ formule: 'seul', devenir: 'mba', repondeur: 'mba' }, 'rcs')).toEqual({});
    expect(repondeurAEnvoyer({ formule: 'seul', devenir: 'mba', repondeur: `agent:${AG}` }, 'email')).toEqual({});
  });

  it('l’agent de Meta, ou l’agent IA avec son identifiant, au format que le serveur valide (0263)', () => {
    expect(repondeurAEnvoyer({ formule: 'seul', devenir: 'mba', repondeur: 'mba' }, 'whatsapp')).toEqual({ repondeur: 'mba' });
    expect(repondeurAEnvoyer({ formule: 'seul', devenir: 'mba', repondeur: `agent:${AG}` }, 'whatsapp')).toEqual({ repondeur: 'agent', repondeurAgentId: AG });
  });

  it('un choix lu d’un brouillon : un identifiant mal formé ne devient jamais un agent', () => {
    expect(lireChoixRepondeur('mba')).toBe('mba');
    expect(lireChoixRepondeur(`agent:${AG}`)).toBe(`agent:${AG}`);
    expect(lireChoixRepondeur('agent:x')).toBeUndefined();
    expect(lireChoixRepondeur(42)).toBeUndefined();
  });
});
