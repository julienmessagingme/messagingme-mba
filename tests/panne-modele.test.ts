import { describe, it, expect } from 'vitest';
import { direPanneModele, LlmApiError, PlafondModeleAtteint } from '../src/llm/errors';
import { HttpTimeoutError } from '../src/meta/http';

/**
 * CE QU'UNE ROUTE A LE DROIT DE DIRE AU CLIENT QUAND L'APPEL AU MODÈLE ÉCHOUE (2026-09-22).
 *
 * 🔴 `null` est la réponse qui protège : il veut dire « c'est NOTRE panne », et la route la relance pour que
 * le gestionnaire global rende un 500 opaque. Le bac à sable rendait jusque-là `err.message` en 422 pour tout
 * ce que son `catch` attrapait, lecture en base comprise.
 */
describe('direPanneModele', () => {
  it('🔴 le plafond passe AVANT le refus générique, dont il est une sous-classe', () => {
    // Vercel refuse un plafond atteint en 429, qui est rejouable dans la règle générale : sans cet ordre, le
    // client lirait « indisponible, réessayez » sur un crédit épuisé, et réessaierait pour rien.
    expect(direPanneModele(new PlafondModeleAtteint(429, 'quota_for_entity_exceeded 12.40 USD'))).toBe('le crédit du modèle est épuisé');
  });

  it('un refus rejouable se dit « indisponible », un refus terminal donne son statut', () => {
    expect(direPanneModele(new LlmApiError(503, 'Service Unavailable', true))).toMatch(/indisponible pour le moment/);
    expect(direPanneModele(new LlmApiError(429, 'Too Many Requests', true))).toMatch(/indisponible pour le moment/);
    expect(direPanneModele(new LlmApiError(404, 'model not found', false))).toBe('le fournisseur du modèle a refusé l’appel (HTTP 404)');
  });

  it('🔴 le texte du fournisseur n’est JAMAIS recopié', () => {
    // Anglais, écrit pour un développeur, et il peut porter des montants : il reste dans le journal.
    for (const err of [
      new LlmApiError(401, 'Invalid API key sk-XXXX', false),
      new LlmApiError(500, 'upstream exploded at 10.0.3.7', true),
      new PlafondModeleAtteint(429, 'spent 99.12 of 100 USD'),
    ]) {
      const raison = direPanneModele(err) ?? '';
      expect(raison, err.message).not.toContain(err.message);
      expect(raison, err.message).not.toMatch(/sk-|10\.0\.3\.7|USD/);
    }
  });

  it('un délai dépassé se dit, quelle que soit sa forme', () => {
    // Notre plafond de transport, l'échéance de l'appelant (`AbortSignal.timeout`), un abandon. Dans les
    // routes qui appellent cette fonction, c'est l'appel au modèle : l'exécuteur rattrape ceux des outils.
    const abandon = new Error('This operation was aborted'); abandon.name = 'AbortError';
    const echeance = new Error('The operation was aborted due to timeout'); echeance.name = 'TimeoutError';
    for (const err of [new HttpTimeoutError('https://ai-gateway.vercel.sh/v1/chat', 120_000), abandon, echeance]) {
      expect(direPanneModele(err), err.name).toBe('le modèle n’a pas répondu à temps, réessayez dans un instant');
    }
  });

  it('une coupure réseau de `fetch` dit « injoignable », sans sa cause', () => {
    // La forme exacte d'undici : un TypeError « fetch failed », la cause réseau rangée dessous.
    const coupure = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 76.76.21.21:443'), { code: 'ECONNREFUSED' }) });
    const raison = direPanneModele(coupure);
    expect(raison).toBe('le fournisseur du modèle est injoignable pour le moment, réessayez dans un instant');
    expect(raison).not.toContain('76.76');
  });

  it('🔴 TOUT le reste est à nous, et rend null', () => {
    // Ce que lève `pg` quand la base est injoignable : une Error avec un code, pas le TypeError de `fetch`.
    const baseInjoignable = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' });
    for (const err of [
      new Error('password authentication failed for user "postgres.abcdef"'),
      new TypeError('Cannot read properties of undefined'),
      baseInjoignable,
      // Un TypeError qui n'est PAS celui de `fetch` reste une faute de programmation.
      new TypeError('fetch failed because of x'),
      'une chaîne',
      undefined,
      null,
    ]) {
      expect(direPanneModele(err), String(err)).toBeNull();
    }
  });
});
