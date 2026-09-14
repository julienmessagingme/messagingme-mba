import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MESSAGE_PLAFOND, moisDe, resteDuBudget, tourAutorise } from '../src/assistant/budget';

/**
 * LE PLAFOND DE CE QUE NOUS DÉPENSONS pour les assistants de configuration.
 *
 * 🔴 IL EXISTE PARCE QUE LE PAYEUR A CHANGÉ (2026-09-14). Sur le crédit prépayé du client, un bavardage se
 * payait tout seul ; sur notre clé maison, rien ne le borne. Les deux moitiés de cette décision vont
 * ensemble, et l'une sans l'autre est dangereuse.
 */
describe('le plafond de l’assistant', () => {
  it('compte par mois CALENDAIRE, pas sur trente jours glissants', () => {
    expect(moisDe(new Date('2026-09-30T23:59:59Z'))).toBe('2026-09-01');
    expect(moisDe(new Date('2026-10-01T00:00:00Z'))).toBe('2026-10-01');
    // ⚠️ En UTC, et le cas qui le prouve est un 1er du mois juste après minuit à Paris (donc encore la
    // veille en UTC) : un décompte en heure locale ferait basculer le mois au mauvais moment.
    expect(moisDe(new Date('2026-10-01T00:30:00+02:00'))).toBe('2026-09-01');
  });

  it('🔴 0 DÉSACTIVE le plafond : c’est le levier d’urgence', () => {
    // Un mauvais calibrage couperait l'assistant de tous les clients, et un `--force-recreate` va plus vite
    // qu'un déploiement de code. Même convention que les limiteurs de débit de ce dépôt.
    expect(resteDuBudget(9_999_999_999, 0)).toBe(Infinity);
    expect(tourAutorise(9_999_999_999, 0)).toBe(true);
  });

  it('rend ce qui reste, et jamais un nombre négatif', () => {
    expect(resteDuBudget(500_000, 2)).toBe(1_500_000);
    expect(resteDuBudget(2_000_000, 2)).toBe(0);
    // Un dépassement est possible : le dernier tour est autorisé puis noté avec son coût réel.
    expect(resteDuBudget(2_500_000, 2)).toBe(0);
  });

  it('🔴 le dernier tour passe, le suivant non', () => {
    // ⚠️ ON AUTORISE SUR CE QUI RESTE, PAS SUR UNE ESTIMATION : le coût réel n'est connu qu'APRÈS l'appel.
    // Le dépassement est donc borné par le coût d'un tour, ce qui est assumé.
    expect(tourAutorise(1_999_999, 2)).toBe(true);
    expect(tourAutorise(2_000_000, 2)).toBe(false);
  });

  it('⚠️ une dépense négative ou absurde ne crédite personne', () => {
    expect(resteDuBudget(-1_000_000, 2)).toBe(2_000_000);
  });

  it('le message du plafond dit la limite ET que les onglets restent', () => {
    // Un message d'indisponibilité générique ferait passer une limite VOLONTAIRE pour une panne ; taire les
    // onglets laisserait croire que tout est bloqué.
    expect(MESSAGE_PLAFOND).toMatch(/mois prochain/i);
    expect(MESSAGE_PLAFOND).toMatch(/onglets/i);
  });
});

/**
 * 🔴 LA GARDE QUE LE FAUX CÂBLAGE NE PEUT PAS DONNER : qui PAIE l'assistant.
 *
 * Les deux clients ont la même signature, et un appel facturé au client marche parfaitement. Le seul moyen
 * de voir l'erreur est de lire le câblage réel.
 */
describe('le vrai câblage : c’est NOUS qui payons l’assistant', () => {
  const src = readFileSync(resolve(__dirname, '../src/index.ts'), 'utf8');
  const bloc = src.slice(src.indexOf('agentSetup: {'), src.indexOf('agentTest: {'));

  it('🔴 passe par la clé maison, jamais par le résolveur de clé par espace', () => {
    expect(bloc).toContain('gatewayAide.completer');
    // Le `[^e]` écarte `gatewayAide.completer` lui-même : c'est `gateway.completer` qu'on refuse ici.
    expect(bloc).not.toMatch(/[^e]gateway\.completer/);
  });

  it('🔴 et ne passe AUCUN espace payeur', () => {
    // Y remettre le tenant refacturerait le client sans que rien ne le signale : `gatewayAide` est construit
    // sans résolveur, donc la valeur n'est jamais lue pour choisir une clé.
    expect(bloc).toContain('AUCUN_ESPACE_PAYEUR');
  });
});
