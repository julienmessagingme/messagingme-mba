import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRIX_MESSAGE_AGENT_USD } from '../src/http/mba';

/**
 * Le prix public d'un message de l'agent de Meta vit deux fois : côté serveur (la carte de Performance lab le reçoit avec
 * les chiffres) et côté console (l'estimation du plafond, `web/lib/api-mba.ts`). Deux copies dérivent : celle-ci les
 * recolle (relecture du 2026-10-02). Lue en texte : le module de la console importe le client HTTP du navigateur.
 */
describe('le prix public d’un message de l’agent de Meta, des deux côtés', () => {
  it('la console et le serveur annoncent le même prix par réponse', () => {
    const source = readFileSync(join(__dirname, '..', 'web', 'lib', 'api-mba.ts'), 'utf8');
    const m = source.match(/PRIX_REPONSE_USD = \{ min: ([0-9.]+), max: ([0-9.]+) \}/);
    expect(m, 'PRIX_REPONSE_USD introuvable dans web/lib/api-mba.ts').not.toBeNull();
    expect({ min: Number(m![1]), max: Number(m![2]) }).toEqual(PRIX_MESSAGE_AGENT_USD);
  });
});
