import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * LES GARDES DE L'ACTION DE WORKFLOW HUBSPOT, LUES DANS LE CÂBLAGE (cadrage du 2026-10-27, relecture du lot 1). Le test de
 * route monte de fausses dépendances : il prouve que la route APPELLE ses gardes, pas que la production les BRANCHE. Une
 * flèche à trois paramètres reste assignable à `EnvoyerPublic` : `(t, c, compter) => lancerEnvoiPublic(...)` compilerait,
 * passerait la suite et perdrait `serviceSeulement`, donc un modèle devenu Marketing partirait aux fiches `opted_in`
 * (décision 3). De même `workflowsBranches: async () => true`. Ce test lit ce que `src/index.ts` branche.
 */
const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** Le bloc `hubspotWorkflow: { ... } satisfies HubspotWorkflowDeps`, seul lieu où ces gardes se branchent. */
const bloc = (() => {
  const debut = index.indexOf('hubspotWorkflow: {');
  const fin = index.indexOf('} satisfies HubspotWorkflowDeps', debut);
  expect(debut).toBeGreaterThan(0);
  expect(fin).toBeGreaterThan(debut);
  return index.slice(debut, fin);
})();

describe('le câblage de l’action de workflow HubSpot', () => {
  it('🔴 l’envoi est le cœur public, et ses options (Service seulement, sans campagne vide, le nom) arrivent jusqu’à lui', () => {
    expect(bloc).toContain('envoyer: (tenant, corps, compter, options) => lancerEnvoiPublic(depsEnvois, tenant, corps, undefined, compter, options),');
  });

  it('🔴 l’offre et le réglage sont ceux de l’espace, relus à chaque appel, jamais une constante', () => {
    expect(bloc).toContain('fonctions: async (t: string) => (await offres.offreDe(t)).droits.fonctions,');
    expect(bloc).toContain('workflowsBranches: async (t: string) => (await settingsStore.lireChoixHubspot(t)).workflows,');
  });

  it('🔴 la ligne et la filière sont lues sur l’espace', () => {
    expect(bloc).toContain('ligneHubspot: async (t: string) => etatLigneHubspot(await phoneStatusStore.getPhoneNumber(t)),');
    expect(bloc).toContain('filiere: (t: string) => comptesApplication.filiereDe(t),');
  });

  it('🔴 les plafonds comptent au total des copies, sur leurs propres réglages', () => {
    expect(bloc).toContain('plafonds: plafondsDesWorkflows(compteurDebit, { parMinute: config.HUBSPOT_WORKFLOWS_PAR_MINUTE, parJour: config.HUBSPOT_WORKFLOWS_PAR_JOUR }),');
  });

  it('le catalogue est celui de `GET /v1/templates`, le nom de l’espace celui de `/ops`', () => {
    expect(bloc).toContain('catalogue: listerModeles,');
    expect(bloc).toContain('nomEspace: (t: string) => opsStore.getTenantName(t),');
  });

  it('🔴 l’action scénario : les scénarios en ligne de l’espace, et la conversation tenue par un opérateur, relue', () => {
    // `conseillerEnMain: async () => false` compilerait : l'historique du workflow mentirait (relecture du 2026-10-29).
    expect(bloc).toContain('scenariosPublies: (t: string) => workflowStore.listPublies(t),');
    expect(bloc).toContain("conseillerEnMain: async (t: string, waId: string) => (await inboxStore.getControlOwner(t, waId)) === 'app_human',");
  });
});
