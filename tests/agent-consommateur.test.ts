import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { consommateurAgent, consommateurMba, agentDuConsommateur, FORME_CONSOMMATEUR } from '../src/agent/consommateur';

/**
 * La clé de consommateur d'un outil.
 *
 * 🔴 CE FICHIER NE PROTÈGE PAS UNE CONCATÉNATION, IL PROTÈGE UN ACCORD ENTRE DEUX FICHIERS. La forme de la
 * clé est écrite à DEUX endroits : ici en TypeScript, et en CHECK dans la migration 0127. Une clé que le
 * code fabriquerait et que la base refuserait remonterait en 500 au moment précis où un client active un
 * outil, en production. L'invariant n'est visible dans aucun des deux fichiers : il ne peut vivre que dans
 * un test, et c'est le dernier de ce fichier.
 */
describe('la clé de consommateur', () => {
  it('un agent devient « agent:<uuid> »', () => {
    expect(consommateurAgent('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe('agent:3f2504e0-4f89-11d3-9a0c-0305e82c3301');
  });

  it('🔴 un identifiant en majuscules donne la MÊME clé (sinon CHECK refusé, ou consentements manqués au retrait)', () => {
    expect(consommateurAgent('3F2504E0-4F89-11D3-9A0C-0305E82C3301')).toBe('agent:3f2504e0-4f89-11d3-9a0c-0305e82c3301');
  });

  it('le MBA devient « mba:<phone_number_id> »', () => {
    expect(consommateurMba('1234840649713976')).toBe('mba:1234840649713976');
  });

  it('🔴 on retrouve l’agent, et SEULEMENT quand c’en est un', () => {
    // Sans cette distinction, un écran qui liste « les agents qui utilisent cet outil » compterait le MBA
    // parmi eux, et proposerait d'ouvrir une fiche d'agent qui n'existe pas.
    expect(agentDuConsommateur('agent:3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe('3f2504e0-4f89-11d3-9a0c-0305e82c3301');
    expect(agentDuConsommateur('mba:1234840649713976')).toBeNull();
    expect(agentDuConsommateur('nimporte quoi')).toBeNull();
  });

  it('🔴 refuse ce qui n’est ni l’un ni l’autre', () => {
    // Une clé malformée produirait une ligne MUETTE : aucun consommateur ne la lirait, et l'outil paraîtrait
    // simplement inactif. C'est le pire des symptômes, celui qui n'a rien à diagnostiquer.
    for (const mauvais of [
      'agent:', 'agent:pas-un-uuid', 'mba:', 'mba:12a', '',
      'agent:3f2504e0-4f89-11d3-9a0c-0305e82c3301 ', ' agent:3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      'AGENT:3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    ]) {
      expect(FORME_CONSOMMATEUR.test(mauvais)).toBe(false);
    }
  });

  it('accepte les deux formes légitimes', () => {
    expect(FORME_CONSOMMATEUR.test('agent:3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe(true);
    expect(FORME_CONSOMMATEUR.test('mba:1234840649713976')).toBe(true);
  });

  it('🔴 la forme est LA MÊME que le CHECK de la migration 0127', () => {
    // Deux constantes de fichiers différents qui doivent rester ordonnées. Le jour où quelqu'un élargit la
    // forme d'un côté sans l'autre, ce test tombe ici plutôt qu'en production sur un `check constraint
    // violation` que personne n'aura relié à ce changement.
    const sql = readFileSync(join(process.cwd(), 'db/migrations/0127_outils_consommateurs.sql'), 'utf8');
    expect(sql).toContain(FORME_CONSOMMATEUR.source);
  });
});
