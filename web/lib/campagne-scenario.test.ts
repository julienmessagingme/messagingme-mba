import { describe, it, expect } from 'vitest';
import { scenariosPourEtage, type ScenarioChoisissable } from './campagne-scenario';

/**
 * LE FILTRAGE DES SCÉNARIOS PAR CANAL D'ÉTAGE.
 *
 * 🔴 CE QU'IL PROTÈGE : un scénario qui ouvre par un modèle WhatsApp, proposé sur un étage de repli RCS,
 * fait refuser la campagne ENTIÈRE par Meta, pas un destinataire. Et le cas de TOLÉRANCE, qui est le plus
 * facile à casser sans s'en apercevoir : un serveur plus ancien ne rend pas le canal, et masquer ce qu'on ne
 * sait pas viderait toute la liste au premier déploiement partiel.
 */
const s = (id: string, canalOuverture?: 'whatsapp' | 'rcs' | null): ScenarioChoisissable => ({
  id, name: `scenario ${id}`, ...(canalOuverture !== undefined ? { canalOuverture } : {}),
});

describe('scenariosPourEtage', () => {
  it('un étage WhatsApp ne voit que les scénarios qui ouvrent en WhatsApp', () => {
    const tous = [s('a', 'whatsapp'), s('b', 'rcs'), s('c', 'whatsapp')];
    expect(scenariosPourEtage(tous, 'whatsapp').map((x) => x.id)).toEqual(['a', 'c']);
  });

  it('un étage RCS ne voit que les scénarios qui ouvrent en RCS', () => {
    const tous = [s('a', 'whatsapp'), s('b', 'rcs'), s('c', 'whatsapp')];
    expect(scenariosPourEtage(tous, 'rcs').map((x) => x.id)).toEqual(['b']);
  });

  it('un scénario qui n’ouvre RIEN n’est proposé nulle part', () => {
    const tous = [s('a', null), s('b', 'whatsapp')];
    expect(scenariosPourEtage(tous, 'whatsapp').map((x) => x.id)).toEqual(['b']);
    expect(scenariosPourEtage(tous, 'rcs')).toEqual([]);
  });

  /**
   * 🔴 AUCUN SCÉNARIO N'OUVRE UN E-MAIL. Ce n'est pas une question de version de serveur : le canal
   * d'ouverture ne vaut que `whatsapp` ou `rcs`.
   */
  it('🔴 un étage e-mail ne se voit proposer AUCUN scénario, même ceux dont on ignore le canal', () => {
    expect(scenariosPourEtage([s('a', 'whatsapp'), s('b'), s('c', 'rcs')], 'email')).toEqual([]);
  });

  /**
   * 🔴 LE CAS DE TOLÉRANCE. Le front part sur Vercel à chaque push, l'API suit à la main : entre les deux,
   * la liste ne porte pas encore le canal. Masquer ce qu'on ne sait pas annoncerait « aucun scénario
   * lançable sur cet espace » à un client qui en a douze.
   */
  it('🔴 un scénario dont on ignore le canal est GARDÉ, pas masqué', () => {
    expect(scenariosPourEtage([s('a'), s('b')], 'whatsapp').map((x) => x.id)).toEqual(['a', 'b']);
    expect(scenariosPourEtage([s('a'), s('b')], 'rcs').map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('⚠️ et « ignoré » n’est pas « aucun » : `null` se masque, `undefined` se garde', () => {
    // Les deux se ressemblent à la lecture et ne veulent pas du tout dire la même chose.
    expect(scenariosPourEtage([s('connu', null)], 'whatsapp')).toEqual([]);
    expect(scenariosPourEtage([s('inconnu')], 'whatsapp')).toHaveLength(1);
  });

  it('une liste vide reste vide, sans jeter', () => {
    expect(scenariosPourEtage([], 'whatsapp')).toEqual([]);
  });

  it('l’ordre d’origine est conservé : c’est celui de la liste du serveur', () => {
    const tous = [s('z', 'whatsapp'), s('a', 'whatsapp'), s('m', 'whatsapp')];
    expect(scenariosPourEtage(tous, 'whatsapp').map((x) => x.id)).toEqual(['z', 'a', 'm']);
  });
});
