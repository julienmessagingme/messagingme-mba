import { describe, it, expect } from 'vitest';
import { VALID_API_SCOPES, MAX_CLES_API_ACTIVES } from '../src/http/api-keys';
import { DROIT_RELAIS } from '../src/mba/cle-relais';
import { API_SCOPES, API_SCOPES_PAR_DEFAUT, MAX_CLES_API_ACTIVES as MAX_ECRAN, DROIT_RELAIS as DROIT_RELAIS_ECRAN } from '../web/lib/api/integrations';

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

  it('🔴 l’écran annonce le même plafond de clés actives que celui que le serveur applique', () => {
    expect(MAX_ECRAN).toBe(MAX_CLES_API_ACTIVES);
  });

  it('🔴 l’écran reconnaît la clé du relais par le même droit que le serveur, sinon il la compterait dans le plafond', () => {
    expect(DROIT_RELAIS_ECRAN).toBe(DROIT_RELAIS);
    expect(API_SCOPES as readonly string[]).not.toContain(DROIT_RELAIS_ECRAN);
  });

  it('⚠️ lire les fiches n’est pas coché d’avance : ce sont des données personnelles, on le choisit', () => {
    expect(API_SCOPES_PAR_DEFAUT).not.toContain('contacts:read');
  });
});
