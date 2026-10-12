import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { OUTILS } from '../src/mcp/outils';
import { OUTILS_MCP } from '../web/lib/mcp-outils';
import { CATALOGUE_MCP, MAX_FICHES_PAR_AJOUT, MAX_MESSAGES_MCP } from '../web/lib/partage/catalogue-mcp';

/** La publication et les handlers traversent le même catalogue, sans lire leur source comme du texte. */
describe('catalogue MCP partagé entre serveur et documentation', () => {
  it('chaque fiche a un handler et un texte bilingue, sans nom en double', () => {
    const noms = OUTILS.map((o) => o.nom);
    expect(new Set(noms).size).toBe(noms.length);
    expect([...noms].sort()).toEqual(Object.keys(CATALOGUE_MCP).sort());
    expect(OUTILS_MCP.map((o) => o.nom).sort()).toEqual([...noms].sort());
    for (const doc of OUTILS_MCP) expect(doc.quoi.every((texte) => texte.trim() !== '')).toBe(true);
  });

  it('les droits et l’exigence OAuth visibles sont ceux de chaque handler', () => {
    const handlers = new Map(OUTILS.map((outil) => [outil.nom, outil]));
    for (const doc of OUTILS_MCP) {
      const handler = handlers.get(doc.nom);
      expect(handler, `handler absent pour ${doc.nom}`).toBeDefined();
      expect(doc.scope, `droit de ${doc.nom}`).toBe(handler?.scope);
      expect(doc.oauth === true, `OAuth de ${doc.nom}`).toBe(handler?.exigePersonne === true);
    }
  });

  it('la page annonce les bornes utilisées par les deux handlers concernés', () => {
    const messages = OUTILS_MCP.find((o) => o.nom === 'get_messages');
    const fiches = OUTILS_MCP.find((o) => o.nom === 'add_knowledge');
    expect(messages?.quoi[0]).toContain(`Les ${MAX_MESSAGES_MCP} derniers messages`);
    expect(messages?.quoi[1]).toContain(`The last ${MAX_MESSAGES_MCP} messages`);
    expect(fiches?.quoi[0]).toContain(`${MAX_FICHES_PAR_AJOUT} au plus par appel`);
    expect(fiches?.quoi[1]).toContain(`up to ${MAX_FICHES_PAR_AJOUT} per call`);
  });

  /** Un agent IA peut répondre seul une fois désigné comme répondeur de l'espace. */
  it('ni la page ni `features.md` ne disent plus qu’un agent IA ne répond jamais seul', () => {
    const page = readFileSync(new URL('../web/app/developers/mcp/page.tsx', import.meta.url), 'utf8');
    expect(page).not.toMatch(/ne répond pas seul|does not answer on its own|que dans un scénario publié/);
    expect(page).toContain('set_default_responder');
    const features = readFileSync(new URL('../features.md', import.meta.url), 'utf8');
    expect(features).not.toMatch(/ne répond encore à personne tout seul|il ne parle que dans le bloc Agent IA/);
  });
});
