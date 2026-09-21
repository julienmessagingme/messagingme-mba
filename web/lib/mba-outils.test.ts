import { describe, it, expect } from 'vitest';
import { etatsChezMeta, effacementsImprevus, nomTechniqueDepuisTitre, consigneIncomplete, TEXTES_PAR_TYPE, PLACEHOLDER } from './mba-outils';
import type { OutilMbaVue } from './api-mba-outils';

/**
 * Les aides pures de l'onglet « Outils » de l'agent de Meta (spec 2026-09-21-outils-maison-mba, § 9).
 */
const o = (id: string, name: string, actif = true, publiable = true): OutilMbaVue => ({
  id, name, title: name, description: 'd', nePasUtiliser: 'p', type: 'tag', cible: { type: 'tag', tag: 'x' },
  cibleManquante: null, aussiUtilisePar: [], actif, publiable,
});

describe('l’état chez Meta, ligne par ligne', () => {
  it('🔴 « À envoyer » quand le plan porte un geste sur CET outil, « Chez Meta » sinon', () => {
    const e = etatsChezMeta([o('1', 'a'), o('2', 'b')], [{ type: 'outil_modifier', nom: 'b' }]);
    expect(e.get('1')).toBe('chez_meta');
    expect(e.get('2')).toBe('a_envoyer');
  });

  it('🔴 TOUT est « À envoyer » quand le connecteur doit être renvoyé (clé révoquée)', () => {
    const e = etatsChezMeta([o('1', 'a'), o('2', 'b')], [{ type: 'connecteur_modifier', nom: 'EngageMe' }]);
    expect([e.get('1'), e.get('2')]).toEqual(['a_envoyer', 'a_envoyer']);
  });

  it('🔴 un outil désactivé est « désactivé », jamais « Chez Meta »', () => {
    expect(etatsChezMeta([o('1', 'a', false)], []).get('1')).toBe('desactive');
    expect(etatsChezMeta([o('1', 'a', false)], null).get('1')).toBe('desactive');
  });

  it('🔴 un outil désactivé que Meta liste ENCORE le dit : rien ne republie au départ de son auteur', () => {
    expect(etatsChezMeta([o('1', 'a', false)], [{ type: 'outil_supprimer', nom: 'a' }]).get('1')).toBe('desactive_a_retirer');
  });

  it('🔴 un outil qui ne part jamais chez Meta n’y est jamais « ✓ »', () => {
    // Un appel supprimé, un outil illisible : `outilsAPublier` le saute, donc aucun geste ne le nomme.
    expect(etatsChezMeta([o('1', 'a', true, false)], []).get('1')).toBe('hors_meta');
    // Publié avant de devenir impubliable : l'envoi l'en retirera.
    expect(etatsChezMeta([o('1', 'a', true, false)], [{ type: 'outil_supprimer', nom: 'a' }]).get('1')).toBe('a_envoyer');
  });

  it('« inconnu » quand Meta n’a pas pu être lu', () => {
    expect(etatsChezMeta([o('1', 'a')], null).get('1')).toBe('inconnu');
  });
});

describe('les effacements que personne n’a demandés', () => {
  it('🔴 ne remonte que ce qui n’est pas attendu', () => {
    const g = [
      { type: 'outil_supprimer' as const, nom: 'a' },
      { type: 'outil_supprimer' as const, nom: 'main_levee' },
      { type: 'connecteur_supprimer' as const, nom: 'EngageMe' },
      { type: 'outil_creer' as const, nom: 'c' },
    ];
    expect(effacementsImprevus(g, new Set(['a', 'EngageMe'])).map((x) => x.nom)).toEqual(['main_levee']);
  });
});

describe('le nom technique et les consignes', () => {
  it('se calcule depuis le titre', () => {
    expect(nomTechniqueDepuisTitre('Marquer client VIP !')).toBe('marquer_client_vip');
  });

  it('🔴 une consigne pré-remplie non complétée est signalée, dans les deux langues', () => {
    for (const x of Object.values(TEXTES_PAR_TYPE)) {
      expect(consigneIncomplete(x.quand[0])).toBe(true);
      expect(consigneIncomplete(x.quand[1])).toBe(true);
    }
    expect(consigneIncomplete(`Appelle cet outil dès que le client demande un devis.`)).toBe(false);
    expect(TEXTES_PAR_TYPE.tag.quand[0]).toContain(PLACEHOLDER);
  });
});
