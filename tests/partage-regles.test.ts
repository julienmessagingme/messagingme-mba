import { describe, it, expect } from 'vitest';
import { META_TEMPLATE_LANGUAGES } from '../web/lib/partage/langues-modeles';
import { API_SCOPES, DROIT_RELAIS } from '../web/lib/partage/droits-api';
import { API_SCOPES_PAR_DEFAUT } from '../web/lib/api/integrations';

/**
 * Ce que le partage d'une liste entre le serveur et la console ne garantit pas à lui seul : les propriétés de la liste
 * elle-même. Ces cas viennent des tests de parité qui comparaient les deux copies, et ils survivent à leur disparition.
 */
describe('les langues d’un modèle', () => {
  it('aucun code en double : le sélecteur afficherait deux fois la même langue', () => {
    const codes = META_TEMPLATE_LANGUAGES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('les droits d’une clé d’API', () => {
  it('🔴 le droit du relais n’est PAS attribuable depuis l’écran : son porteur agit au nom de n’importe quel contact', () => {
    expect(API_SCOPES as readonly string[]).not.toContain(DROIT_RELAIS);
  });

  it('⚠️ lire les fiches n’est pas coché d’avance : ce sont des données personnelles, on le choisit', () => {
    expect(API_SCOPES_PAR_DEFAUT).not.toContain('contacts:read');
  });
});
