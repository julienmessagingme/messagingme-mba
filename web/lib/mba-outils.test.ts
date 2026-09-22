import { describe, it, expect } from 'vitest';
import {
  etatsChezMeta, effacementsImprevus, nomTechniqueDepuisTitre, consigneIncomplete, TEXTES_PAR_TYPE, PLACEHOLDER,
  chezMetaSansLigne, valeursPermises,
} from './mba-outils';
import type { OutilMbaVue } from './api-mba-outils';

/**
 * Les aides pures de l'onglet « Outils » de l'agent de Meta (spec 2026-09-21-outils-maison-mba, § 9).
 */
const o = (id: string, name: string, actif = true, publiable = true): OutilMbaVue => ({
  id, name, title: name, description: 'd', nePasUtiliser: 'p', type: 'tag', cible: { type: 'tag', tag: 'x' },
  cibleManquante: null, aussiUtilisePar: [], actif, publiable, risque: 'write',
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

describe('ce que Meta liste encore sans outil ici', () => {
  it('🔴 un effacement prévu sans ligne ici est remonté ; un outil qui a sa ligne ne l’est pas', () => {
    // Supprimé ici, ou ajouté à la main chez Meta : l'écran ne sait pas lequel, d'où un texte neutre.
    const g = [
      { type: 'outil_supprimer' as const, nom: 'parti' },
      { type: 'outil_supprimer' as const, nom: 'a' },
      { type: 'outil_modifier' as const, nom: 'b' },
    ];
    expect(chezMetaSansLigne([o('1', 'a', false), o('2', 'b')], g)).toEqual(['parti']);
  });

  it('⚠️ Meta illisible : rien à affirmer', () => {
    expect(chezMetaSansLigne([], null)).toEqual([]);
  });
});

describe('les valeurs permises', () => {
  it('🔴 les vides et les DOUBLONS partent, l’ordre de saisie reste', () => {
    expect(valeursPermises('Paris\n\n Lyon \nParis\nLyon')).toEqual(['Paris', 'Lyon']);
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
    expect(effacementsImprevus(g, new Set(['a'])).map((x) => x.nom)).toEqual(['main_levee']);
  });

  it('🔴 un OUTIL nommé comme notre connecteur n’est pas dispensé, un ANCIEN connecteur non plus', () => {
    // Une liste de noms unique dispensait l'un et l'autre dès qu'on y mettait « EngageMe ».
    const g = [
      { type: 'outil_supprimer' as const, nom: 'EngageMe' },
      { type: 'connecteur_supprimer' as const, nom: 'testUCHAT' },
      { type: 'connecteur_supprimer' as const, nom: 'EngageMe' },
    ];
    expect(effacementsImprevus(g, new Set()).map((x) => `${x.type}:${x.nom}`))
      .toEqual(['outil_supprimer:EngageMe', 'connecteur_supprimer:testUCHAT']);
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

  it('🔴 bloc et scénario : l’agent annonce en une phrase, ne passe pas la main, et peut relancer plus tard (essais du 2026-09-22)', () => {
    for (const type of ['bloc', 'scenario'] as const) {
      const [fr, en] = TEXTES_PAR_TYPE[type].quand;
      expect(fr).toContain('en une phrase courte');
      expect(fr).toContain('Ne passe pas la main');
      expect(fr).not.toMatch(/n’écris rien (de plus )?au client pour cette demande/);
      expect(en).toContain('one short sentence');
      // La borne est le MESSAGE du client : « un parcours vient déjà d'être lancé » a fait escalader l'agent.
      expect(TEXTES_PAR_TYPE[type].pasQuand[0]).toContain('même message du client');
    }
    expect(TEXTES_PAR_TYPE.scenario.quand[0]).toContain('même si tu l’as déjà fait plus tôt');
  });
});
