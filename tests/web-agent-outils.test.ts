import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { MAX_NOM_OUTIL, normaliserNomOutil } from '../web/lib/agent-outils';
import { OUTILS_MAISON } from '../src/agent/outils-maison';

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
