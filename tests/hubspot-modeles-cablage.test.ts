import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * LES GARDES DU MODÈLE ENVOYÉ DEPUIS LA CARTE HUBSPOT, LUES DANS LE CÂBLAGE (sous-lot « relancer », relecture du lot).
 * Le test de route monte de fausses dépendances : il prouve que la route APPELLE ses gardes, pas que la production les
 * BRANCHE sur la vraie lecture. Remplacer l'une par `async () => false` ou `'opted_in'` compilerait et passerait la suite,
 * et un contact bloqué, un marketing sans accord ou un modèle non approuvé partirait. Ce test lit ce que `src/index.ts`
 * branche.
 */
const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** Le bloc `hubspotConversation: { ... } satisfies HubspotConversationDeps`, seul lieu où ces gardes se branchent. */
const bloc = (() => {
  const debut = index.indexOf('hubspotConversation: {');
  const fin = index.indexOf('} satisfies HubspotConversationDeps', debut);
  expect(debut).toBeGreaterThan(0);
  expect(fin).toBeGreaterThan(debut);
  return index.slice(debut, fin);
})();

describe('le câblage des gardes du modèle envoyé depuis HubSpot', () => {
  it('🔴 le blocage se lit sur la fiche (`isBlockedByWaId`), jamais une constante', () => {
    expect(bloc).toContain('estBloque: (t: string, waId: string) => contactStore.isBlockedByWaId(t, waId)');
  });

  it('🔴 le réglage « Envoyer des modèles » est celui de l’espace, le consentement celui de la fiche', () => {
    expect(bloc).toContain('branches: async (t: string) => (await settingsStore.lireChoixHubspot(t)).modeles');
    expect(bloc).toContain('const e = await contactStore.getContactStateByWaId(t, waId);');
    expect(bloc).toContain('optIn: e.optIn');
  });

  it('🔴 le modèle est jugé par le verdict de `/v1/sends`, et une panne de lecture est « illisible »', () => {
    expect(bloc).toContain('verdict: verdictModele(info, language)');
    expect(bloc).toContain("verdict: { statut: 'illisible' as const }");
  });

  it('🔴 l’envoi est celui de l’Inbox, avec le STOP de la réponse et la prise du fil', () => {
    expect(bloc).toContain('envoi: { ...envoiModeleOperateur, repo, estDesabonne: depsRepondre.estDesabonne, takeControl: fil.prisEnEcrivant, inbox: inboxStore }');
    expect(index).toContain('...envoiModeleOperateur,');
  });
});
