import { describe, it, expect } from 'vitest';
import { FONCTIONS_OFFRE } from './offre';
import { arriveeDUnNouvelEspace, pageDArrivee, veutLePro } from './session';

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

describe('arriveeDUnNouvelEspace et veutLePro (la fin Pro du guide du numéro, 2026-10-27)', () => {
  it('🔴 un espace neuf prend le tunnel de la Free, sauf venu du choix du Pro : la souscription du Pro', () => {
    expect(arriveeDUnNouvelEspace(false)).toBe('/connecter-whatsapp?suite=demarrer');
    expect(arriveeDUnNouvelEspace(true)).toBe('/offre?fonction=console');
    // La page de l'offre ne montre son bandeau qu'à une fonction qu'elle connaît : la destination en nomme une.
    const fonction = new URLSearchParams(arriveeDUnNouvelEspace(true).split('?')[1]).get('fonction');
    expect(FONCTIONS_OFFRE as readonly string[]).toContain(fonction);
  });

  it('seule la valeur « pro » de ?offre= compte, où qu’elle soit dans l’adresse', () => {
    expect(veutLePro('?offre=pro')).toBe(true);
    expect(veutLePro('?offre=pro&lang=en')).toBe(true);
    expect(veutLePro('?lang=en&offre=pro')).toBe(true);
    expect(veutLePro('')).toBe(false);
    expect(veutLePro('?offre=')).toBe(false);
    expect(veutLePro('?offre=free')).toBe(false);
    expect(veutLePro('?offre=PRO')).toBe(false);
  });
});
