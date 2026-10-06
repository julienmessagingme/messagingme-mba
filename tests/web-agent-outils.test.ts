import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  HANDLER_DU_TYPE, MAX_NOM_OUTIL, TOUJOURS_LA, cibleDeLOutil, corpsDeLaCible, normaliserNomOutil, typeDuHandler,
  type CibleSaisieAgent,
} from '../web/lib/agent-outils';
import { signeDuHandler } from '../web/lib/signes-outils';
import { BORNES_OUTIL } from '../web/lib/mba-outils';
import { BORNES_CIBLE, HANDLERS_A_CIBLE, OUTILS_MAISON } from '../src/agent/outils-maison';
import { lireCibleSaisie } from '../src/agent/reglages';

/**
 * Le nom exposé d'un outil, normalisé côté navigateur, et sa parité avec ce que le serveur accepte.
 *
 * Les deux builds ne partagent aucun module : une règle recopiée finit par diverger, et le champ laisse alors
 * passer un nom que la route refuse en 400, c'est-à-dire une erreur technique pour une faute que l'écran
 * savait déjà. On ancre donc la normalisation SUR la règle du serveur, lue dans sa source.
 */

/** La règle telle que la route la pose, lue dans sa source : le schéma Zod n'exporte pas son motif. */
function motifServeur(): RegExp {
  const source = readFileSync(new URL('../src/http/agent-tools.ts', import.meta.url), 'utf8');
  const m = /const NOM = z\.string\(\)\.trim\(\)\.regex\((\/\^[^/]+\/)/.exec(source);
  expect(m, 'le motif du nom a changé de forme dans src/http/agent-tools.ts').not.toBeNull();
  return new RegExp(m![1]!.slice(1, -1));
}

describe('normaliserNomOutil', () => {
  it('🔴 tout ce qu’elle rend est ACCEPTÉ par le serveur', () => {
    const motif = motifServeur();
    for (const brut of [
      'Poser un tag', 'mba_terminer', 'ENVOYER LE BLOC', 'poser_tâg', 'écrire-variable',
      'a'.repeat(200), 'chercher   la   connaissance', 'outil#1', '_debut', 'fin_',
    ]) {
      const propre = normaliserNomOutil(brut);
      expect(propre, brut).toMatch(motif);
      expect(propre.length, brut).toBeLessThanOrEqual(MAX_NOM_OUTIL);
    }
  });

  it('retire les accents plutôt que de les remplacer par un tiret bas', () => {
    // « poser_tâg » doit devenir « poser_tag » : un filtre naïf sur l'alphabet rendrait « poser_ta_g », que
    // le client ne reconnaîtrait pas comme son nom.
    expect(normaliserNomOutil('poser_tâg')).toBe('poser_tag');
    expect(normaliserNomOutil('créer_rdv')).toBe('creer_rdv');
  });

  it('resserre les séparateurs et met en minuscules', () => {
    expect(normaliserNomOutil('Poser un tag')).toBe('poser_un_tag');
    expect(normaliserNomOutil('outil -- 2')).toBe('outil_2');
  });

  it('🔴 une saisie sans aucun caractère alphanumérique rend une chaîne VIDE', () => {
    // Et pas « _ », que la règle du serveur accepterait : le champ enregistrerait alors « _ » comme nom
    // d'outil exposé au modèle. Vide, l'écran garde le nom précédent, ce que fait le champ à la sortie.
    for (const brut of ['   ', '###', '---', '.', '  --  ']) {
      expect(normaliserNomOutil(brut), brut).toBe('');
    }
  });

  it('🔴 les noms par défaut du catalogue passent la règle du serveur', () => {
    const motif = motifServeur();
    for (const o of OUTILS_MAISON) {
      expect(o.nomDefaut, o.handler).toMatch(motif);
      // Et ils sont déjà normalisés : l'écran ne doit pas proposer de « corriger » un nom qu'il vient de créer.
      expect(normaliserNomOutil(o.nomDefaut), o.handler).toBe(o.nomDefaut);
    }
  });
});

/**
 * 🔴 L'ONGLET OUTILS PRÉSENTÉ COMME CELUI DE L'AGENT DE META (RC4) : ce que l'écran pose doit être ce que le serveur
 * accepte. Les deux builds ne partagent aucun module, donc chaque liste recopiée côté console est tenue ici contre sa
 * source serveur.
 */
describe('RC4 : la console et le catalogue serveur disent la même chose', () => {
  it('🔴 « Toujours là » = les outils du catalogue SANS cible, ni plus ni moins', () => {
    const sansCible = OUTILS_MAISON.map((o) => o.handler).filter((h) => !(HANDLERS_A_CIBLE as readonly string[]).includes(h));
    expect([...TOUJOURS_LA].sort()).toEqual(sansCible.sort());
  });

  it('🔴 les cartes à cible posent exactement les handlers à cible du serveur', () => {
    expect(Object.values(HANDLER_DU_TYPE).sort()).toEqual([...HANDLERS_A_CIBLE].sort());
    for (const h of HANDLERS_A_CIBLE) expect(typeDuHandler(h), h).not.toBeNull();
  });

  it('chaque outil du catalogue a son dessin : aucune ligne sans icône', () => {
    for (const o of OUTILS_MAISON) expect(signeDuHandler(o.handler), o.handler).not.toBeNull();
  });

  it('🔴 les bornes que l’écran applique sont celles de la cible côté serveur', () => {
    expect({ tag: BORNES_OUTIL.tag, champ: BORNES_OUTIL.champ, valeur: BORNES_OUTIL.valeur, valeurs: BORNES_OUTIL.valeurs }).toEqual({ ...BORNES_CIBLE });
  });

  it('🔴 ce que l’écran envoie comme cible est ACCEPTÉ par le serveur, et relu à l’identique', () => {
    const saisies: CibleSaisieAgent[] = [
      { type: 'tag', tag: '  rdv_pris ' },
      { type: 'champ', champ: 'statut', valeurs: ['client', 'prospect'] },
      { type: 'bloc', workflowId: '0b7e2c1a-4d5e-4f60-8a9b-1c2d3e4f5a6b', code: 'nod_t1_01HZX5Y6Z7A8B9C0D1E2F3G4H5' },
      { type: 'scenario', workflowId: '0b7e2c1a-4d5e-4f60-8a9b-1c2d3e4f5a6b' },
    ];
    for (const c of saisies) {
      const handler = HANDLER_DU_TYPE[c.type];
      const lue = lireCibleSaisie(handler, corpsDeLaCible(c));
      expect(lue, c.type).not.toBeNull();
      // Relue par l'écran depuis le `binding` que le serveur écrit : la même cible, rognée.
      expect(cibleDeLOutil({ ...lue! }), c.type).toEqual(c.type === 'tag' ? { type: 'tag', tag: 'rdv_pris' } : c);
    }
  });

  it('un binding sans cible se relit en cible VIDE, que l’écran montre « à choisir » au lieu de planter', () => {
    expect(cibleDeLOutil({ handler: 'poser_tag' })).toEqual({ type: 'tag', tag: '' });
    expect(cibleDeLOutil({ handler: 'ecrire_variable', valeurs: [1, 'a'] })).toEqual({ type: 'champ', champ: '', valeurs: ['a'] });
    expect(cibleDeLOutil({ handler: 'terminer' })).toBeNull();
  });
});
