import { describe, it, expect } from 'vitest';
import { VALID_API_SCOPES } from '../src/http/api-keys';
import { API_SCOPES, API_SCOPES_PAR_DEFAUT } from '../web/lib/api/integrations';

/**
 * LES DROITS D'UNE CLÉ D'API, DES DEUX CÔTÉS (spec de l'API publique, § 10).
 *
 * 🔴 LA LISTE VIT EN DEUX ENDROITS : l'écran qui propose les cases, le serveur qui accepte les droits. Un
 * écran qui propose un droit que le serveur refuse rend 400 à la création ; un droit que l'écran ne propose
 * pas n'est attribuable par personne. Le commentaire « doit rester aligné » ne tenait rien : ce test, si.
 */
describe('parité des droits d’une clé d’API', () => {
  it('🔴 l’écran propose EXACTEMENT les droits que le serveur accepte', () => {
    expect([...API_SCOPES].sort()).toEqual([...VALID_API_SCOPES].sort());
  });

  it('⚠️ lire les fiches n’est pas coché d’avance : ce sont des données personnelles, on le choisit', () => {
    expect(API_SCOPES_PAR_DEFAUT).not.toContain('contacts:read');
  });
});
