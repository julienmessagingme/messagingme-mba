import { describe, it, expect } from 'vitest';
import { repondeursDe, libelleRepondeur, REPONDEURS } from './qui-a-repondu';

const t = (fr: string) => fr;

/**
 * LES BADGES « QUI A REPONDU ».
 *
 * 🔴 CE QUE CES TESTS PROTEGENT : la SOURCE. La tentation naturelle est de lire
 * `conversation_analysis.handled_by`, qui porte le bon nom et repond a une autre question : il ne rend que
 * `humain` ou `automatise`, et sa valeur `mba` n'est JAMAIS produite (mesure en production le 2026-09-17 :
 * zero ligne sur 14). Une conversation menee par l'agent de Meta y serait indiscernable d'un scenario, ce
 * qui est exactement la distinction demandee. La verite est dans `conversation_messages.origin`.
 */
describe('les repondeurs d’une conversation', () => {
  it('🔴 les quatre origines se traduisent en quatre repondeurs', () => {
    expect(repondeursDe(['scenario'])).toEqual(['scripte']);
    expect(repondeursDe(['humain'])).toEqual(['humain']);
    expect(repondeursDe(['mba'])).toEqual(['mba']);
    expect(repondeursDe(['ia'])).toEqual(['agent']);
  });

  it('🔴 une conversation HYBRIDE en porte plusieurs', () => {
    // Le cas nomme par Julien : « parfois repondue par un agent humain puis par le MBA ». Rendre un seul
    // repondeur obligerait a en choisir un, donc a cacher l'autre.
    expect(repondeursDe(['humain', 'mba', 'humain'])).toEqual(['humain', 'mba']);
  });

  it('🔴 l ORDRE est stable, quel que soit l ordre des messages', () => {
    // Sans ordre fixe, deux conversations identiques afficheraient leurs badges dans un ordre different, et
    // l'oeil croirait a une difference qui n'existe pas.
    expect(repondeursDe(['mba', 'humain', 'scenario', 'ia'])).toEqual(['scripte', 'humain', 'mba', 'agent']);
    expect(repondeursDe(['ia', 'scenario', 'humain', 'mba'])).toEqual(['scripte', 'humain', 'mba', 'agent']);
  });

  it('🔴 `mcp` EST un agent IA, pas une cinquieme case', () => {
    // C'est un agent qui appelle un outil, pas un autre repondeur. Le depot fait deja ce rapprochement
    // ailleurs : `serviceIaDetail` somme agent + mba + mcp pour retrouver le theme « ia ».
    expect(repondeursDe(['mcp'])).toEqual(['agent']);
    expect(repondeursDe(['ia', 'mcp'])).toEqual(['agent']);
  });

  it('🔴 `campagne` N EST PAS un repondeur', () => {
    // Un envoi de campagne OUVRE l'echange, il ne repond pas a ce que le client a dit. Le compter ferait
    // porter un badge « on vous a repondu » a toute conversation nee d'une campagne, y compris celles ou
    // personne n'a jamais repondu.
    expect(repondeursDe(['campagne'])).toEqual([]);
    expect(repondeursDe(['campagne', 'humain'])).toEqual(['humain']);
  });

  it('⚠️ aucune origine connue -> AUCUN badge, et c est une information', () => {
    // Une conversation dont tous les sortants sont anterieurs a la migration 0099 n'a pas d'origine. Le bon
    // comportement est de ne rien afficher, pas d'inventer un repondeur par defaut.
    expect(repondeursDe([])).toEqual([]);
    expect(repondeursDe([null, undefined, 'inconnu'])).toEqual([]);
  });

  it('⚠️ chaque repondeur a un libelle, et aucun ne rend une chaine vide', () => {
    // Un `switch` sans cas pour une valeur de l'enumeration compile (le retour devient `undefined`) et
    // afficherait un badge vide. Ce test le rend visible.
    for (const r of REPONDEURS) {
      expect(libelleRepondeur(r, t), `libelle de ${r}`).toBeTruthy();
    }
  });

  it('⚠️ le libelle de l agent IA ne porte PAS de nom d agent', () => {
    // Decision du 2026-09-17 : le nom n'est pas sur le message, et le deduire par numero et fenetre de
    // temps melangerait deux agents parlant au meme numero le meme jour. Tant qu'un espace n'a qu'un agent,
    // le nom n'apprend rien.
    expect(libelleRepondeur('agent', t)).toBe('Agent IA');
  });
});
