import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * LE CÂBLAGE DU BOT D'AIDE, lu dans la source.
 *
 * 🔴 POURQUOI CE TEST NE PEUT PAS ÊTRE UN TEST ORDINAIRE. Ce qui se joue ici est QUI PAIE, et cela ne se
 * voit dans aucune assertion de comportement : le bot répondrait exactement pareil en facturant le client.
 * Julien a tranché le 2026-09-11 que l'aide est à NOTRE charge, parce que facturer quelqu'un pour apprendre
 * à se servir du produit se retourne contre nous. Un câblage qui prend le mauvais client de Gateway
 * renverse cette décision en silence, et personne ne s'en apercevrait avant une facture.
 *
 * Le mécanisme est celui de `cleDe` (`src/agent/llm/chat-client.ts`) : sans résolveur de clé par espace, la
 * clé maison est utilisée. Le client de l'aide est donc construit SANS ce résolveur, délibérément.
 *
 * Même famille que `tests/campagne-cablage.test.ts` et `tests/workflow-cablage-categorie.test.ts` : ce qui
 * traverse un câblage ne se vérifie pas au type, il se vérifie en le regardant.
 */
const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
/** Sans les commentaires : sinon une explication qui CITE le bon code ferait passer un câblage fautif. */
const sansCommentaires = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('câblage du bot d’aide', () => {
  it('🔴 le client du bot d’aide est construit SANS résolveur de clé par espace', () => {
    // Un seul argument : la clé maison. Un troisième argument ferait résoudre la clé DU CLIENT, et l'aide
    // serait facturée sur son crédit prépayé.
    expect(sansCommentaires, 'gatewayAide doit être construit avec la seule clé maison')
      .toMatch(/const gatewayAide = config\.AI_GATEWAY_API_KEY \? new GatewayChatClient\(config\.AI_GATEWAY_API_KEY\) : null;/);
  });

  it('🔴 l’aide n’utilise PAS le client qui fait payer les clients', () => {
    // Le piège exact : `gateway` et `gatewayAide` ne diffèrent que par un mot, et les intervertir compile.
    const bloc = sansCommentaires.slice(sansCommentaires.indexOf('aide: {'), sansCommentaires.indexOf('agentSetup: {'));
    expect(bloc, 'le bloc `aide` n’a pas été trouvé dans le câblage').not.toBe('');
    expect(bloc).toContain('gatewayAide.completer');
    expect(bloc, 'l’aide passerait par le client qui facture l’espace').not.toMatch(/[^A-Za-z]gateway\.completer/);
  });

  it('⚠️ l’aide ne se monte QUE si son modèle est configuré', () => {
    // Sans modèle, la route doit répondre 503 plutôt que de retomber sur le modèle d'un autre usage : celui
    // de l'agent de production coûte plus cher et n'a pas le même métier.
    expect(sansCommentaires).toMatch(/gatewayAide && config\.AGENT_AIDE_MODEL/);
  });

  it('⚠️ le modèle de l’aide est le SIEN, pas celui d’un autre usage', () => {
    const bloc = sansCommentaires.slice(sansCommentaires.indexOf('aide: {'), sansCommentaires.indexOf('agentSetup: {'));
    expect(bloc).toContain('config.AGENT_AIDE_MODEL');
    expect(bloc).not.toContain('AGENT_SETUP_MODEL');
    expect(bloc).not.toContain('AGENT_MODEL,');
  });

  it('🔴 les fiches d’aide sont VECTORISÉES par le balayage du worker', () => {
    // Relevé à la revue du 2026-09-11 : le balayage ne tournait que sur `agent_knowledge`. La colonne
    // `embedding` d'`aide_fiches` serait restée nulle pour toujours, `chercherParVecteur` aurait toujours
    // rendu une liste vide, et le rappel se serait réduit au plein texte. Le bot aurait continué de
    // répondre, ce qui est le pire : on perd exactement le cas pour lequel le sémantique existe.
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    const sansComm = worker.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(sansComm, 'le balayage de vectorisation doit passer sur le dépôt des fiches d’aide')
      .toMatch(/balayerVectorisation\(depotAide, rechercheSemantique, config\.AGENT_EMBED_MODEL\)/);
    // Et le MÊME modèle que la connaissance des agents : les deux colonnes ont la même dimension par
    // construction, en prendre un autre rendrait les deux bases incomparables sans erreur.
    expect(sansComm).toMatch(/balayerVectorisation\(knowledgeStore, rechercheSemantique, config\.AGENT_EMBED_MODEL\)/);
  });

  it('🔴 le module `aide` est bien celui que `ServerDeps` attend, ses DEUX capacités comprises', () => {
    // ⚠️ LE CONTRÔLE DES PROPRIÉTÉS EN TROP NE TRAVERSE PAS UN SPREAD (règle du CLAUDE.md, mesurée) : le
    // câblage monte `repondre` dans un `...( ? {} : {})`, donc une clé mal orthographiée COMPILERAIT et la
    // route ne se monterait jamais. Personne ne le verrait avant qu'un client clique sur le bouton.
    const debut = sansCommentaires.indexOf('aide: {');
    expect(debut, 'le module `aide` n’est pas monté sous ce nom').toBeGreaterThan(-1);
    const bloc = sansCommentaires.slice(debut, sansCommentaires.indexOf('agentSetup: {'));
    expect(bloc, 'la question du bot d’aide n’est plus câblée').toContain('repondre: creerRepondeur(');
    expect(bloc, 'le récap de la veille n’est plus câblé').toContain('calculer: creerRecapRedige(');
  });

  it('⚠️ le RÉCAP tient sans modèle, la question non', () => {
    // Les deux ne dépendent pas de la même chose, et c'est voulu : tout ce qui est chiffré dans un récap
    // sort du SQL, et le gabarit le dit déjà. Monter le récap sous la même condition que la question
    // priverait un client sans modèle configuré d'un écran qui n'a besoin d'aucun modèle.
    const bloc = sansCommentaires.slice(sansCommentaires.indexOf('aide: {'), sansCommentaires.indexOf('agentSetup: {'));
    const recap = bloc.slice(bloc.indexOf('recap: {'), bloc.indexOf('repondre: creerRepondeur('));
    expect(recap, 'le récap doit précéder la question dans le câblage').not.toBe('');
    expect(recap, 'sans modèle, le récap doit retomber sur le gabarit').toContain('gabarit(r, langue)');
  });

  it('🔴 les fiches entrent dans l’IMAGE, sinon le chargeur ne trouve rien en production', () => {
    // `npm run aide:charger` tourne DANS le conteneur, comme `migrate`. Sans cette copie il refuse de
    // charger (zéro fiche trouvée), et le bot répond « je ne sais pas » à tout sans que rien n'explique
    // pourquoi. Relevé avant le premier déploiement, en relisant le Dockerfile.
    const docker = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
    expect(docker, 'le Dockerfile doit copier docs/aide').toMatch(/COPY .*docs\/aide \.\/docs\/aide/);
  });

  it('🔴 la route d’aide est couverte par le garde-fou d’authentification', () => {
    // `src/server.ts` refuse de démarrer si un module à routes `:tenantId` se monte sans `auth`. En ajouter
    // un sans l'inscrire dans cette liste, c'est rouvrir la porte pour lui seul.
    const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
    const bloc = server.slice(server.indexOf('const modulesTenant'), server.indexOf('const app = Fastify'));
    expect(bloc).toContain('deps.aide');
  });
});
