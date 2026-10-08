import { describe, it, expect } from 'vitest';
import { commandeMcp, enSuiteDeDemarrage, NOM_SERVEUR_MCP, promptDeDemarrage, VARIABLE_CLE } from './demarrer';

/**
 * LA PAGE FINALE DU TUNNEL DE LA BASE (lot 19, plan `docs/superpowers/plans/2026-10-08-tunnel-de-la-base.md`) : ce qu'on
 * donne à copier à un espace qui vient de naître pour vivre dans Claude Code.
 */
describe('la commande qui branche Claude Code', () => {
  it('🔴 sans clé ni en-tête : la connexion OAuth s’ouvre au premier usage (décision de Julien)', () => {
    const c = commandeMcp('https://api.messagingme.app');
    expect(c).toBe(`claude mcp add --transport http ${NOM_SERVEUR_MCP} https://api.messagingme.app/mcp`);
    expect(c).not.toMatch(/Authorization|Bearer|--header|VOTRE_CLE/);
  });

  it('une adresse qui finit par une barre ne la double pas', () => {
    expect(commandeMcp('https://api.exemple.test/')).toBe(`claude mcp add --transport http ${NOM_SERVEUR_MCP} https://api.exemple.test/mcp`);
  });
});

describe('la page du numéro sait qu’elle est une étape du tunnel', () => {
  it('par l’adresse, ou par la mémoire de l’onglet quand Stripe a renvoyé sans elle', () => {
    expect(enSuiteDeDemarrage('?suite=demarrer', null)).toBe(true);
    // Le retour de paiement d'un numéro fourni arrive sur `/connecter-whatsapp?abonnement=recu` : la suite y est perdue.
    expect(enSuiteDeDemarrage('?abonnement=recu', 'demarrer')).toBe(true);
    expect(enSuiteDeDemarrage('', null)).toBe(false);
    expect(enSuiteDeDemarrage('?suite=autre', null)).toBe(false);
  });

  it('🟡 la mémoire ne sert qu’au retour de Stripe : un onglet quitté en route ne garde pas le tunnel', () => {
    // Quitté par le menu sans passer par la page finale, puis la page du numéro rouverte depuis l'Accueil.
    expect(enSuiteDeDemarrage('', 'demarrer')).toBe(false);
    expect(enSuiteDeDemarrage('?portail=ouvert', 'demarrer')).toBe(false);
  });
});

describe('le prompt à coller dans Claude Code', () => {
  const DOC = 'https://console.exemple.test/developers/api';

  it('🔴 nomme le serveur MCP, la variable de la clé, interdit la clé dans le code, et pointe la documentation', () => {
    const p = promptDeDemarrage({ langue: 'fr', docApi: DOC, numeroConnecte: true });
    expect(p).toContain(`« ${NOM_SERVEUR_MCP} »`);
    expect(p).toContain(VARIABLE_CLE);
    expect(p).toMatch(/jamais dans le code/);
    expect(p).toContain(DOC);
  });

  it('propose de brancher le numéro seulement s’il ne l’est pas', () => {
    expect(promptDeDemarrage({ langue: 'fr', docApi: DOC, numeroConnecte: false })).toMatch(/start_whatsapp_connection/);
    expect(promptDeDemarrage({ langue: 'fr', docApi: DOC, numeroConnecte: true })).not.toMatch(/start_whatsapp_connection/);
  });

  it('en anglais aussi, avec les mêmes repères', () => {
    const p = promptDeDemarrage({ langue: 'en', docApi: DOC, numeroConnecte: false });
    expect(p).toContain(VARIABLE_CLE);
    expect(p).toMatch(/never in the code/);
    expect(p).toMatch(/start_whatsapp_connection/);
  });

  it('aucun tiret long dans ce qu’on donne à copier', () => {
    for (const langue of ['fr', 'en'] as const) {
      expect(promptDeDemarrage({ langue, docApi: DOC, numeroConnecte: false })).not.toMatch(/[\u2014\u2013]/);
    }
  });
});
