import { describe, it, expect } from 'vitest';
import { pageDArrivee } from './session';

describe('pageDArrivee', () => {
  it('l’admin va sur l’accueil', () => {
    expect(pageDArrivee('admin')).toBe('/accueil');
  });

  it('🔴 tout ce qui n’est PAS admin va sur l’inbox, y compris un rôle qui n’existait pas encore', () => {
    // Écrite à l'envers (« agent -> inbox, sinon accueil »), la règle envoyait le manager sur un écran
    // qu'AppShell lui refuse aussitôt : un aller-retour visible, puis l'inbox. Elle doit suivre la barrière
    // serveur, qui n'ouvre rien à ce qui n'est pas admin.
    expect(pageDArrivee('agent')).toBe('/inbox');
    expect(pageDArrivee('manager')).toBe('/inbox');
    expect(pageDArrivee('superviseur')).toBe('/inbox');
    expect(pageDArrivee('')).toBe('/inbox');
  });
});
