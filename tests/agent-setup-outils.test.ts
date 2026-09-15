import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { differences, propositionSchema, type EtatCourant } from '../src/agent/setup/proposition';
import { construireMessages, type ContexteConstruction } from '../src/agent/setup/conversation';
import { brancheables } from '../src/http/agent-setup';
import { ficheVide } from '../src/agent/fiche';

/**
 * BRANCHER UN OUTIL DEPUIS LA CONVERSATION.
 *
 * 🔴 CE QUI EST BORNÉ ICI EST UN POUVOIR, PAS UN FORMAT. Julien, 2026-09-14 : « il n'a pas la main pour créer
 * des outils puisqu'il n'a que la liste d'outils déjà setuppés, donc au pire il en débranche un ». Brancher
 * agit sur le CONSENTEMENT du couple (outil, consommateur), table `agent_tool_consommateurs` (migration
 * 0127) : la définition appartient à l'ESPACE, et l'assistant n'y touche jamais.
 *
 * 🔴 ET BRANCHER N'ACTIVE PAS. Un outil rattaché est DISPONIBLE ; l'exposer au modèle reste un second geste
 * humain, celui que la migration 0086 rend incontournable.
 */

const CATALOGUE = [
  { nom: 'erp_commandes', titre: 'État de commande', branche: false },
  { nom: 'chercher_connaissance', titre: 'Chercher dans la connaissance', branche: true },
];

const COURANT = (over: Partial<EtatCourant> = {}): EtatCourant => ({
  fiche: { ...ficheVide(), objectif: 'Aider.' },
  mentionIaFrequence: 'session', inactiviteMinutes: 30, outils: [], catalogue: CATALOGUE, ...over,
});

const CTX = (over: Partial<ContexteConstruction> = {}): ContexteConstruction => ({
  ...COURANT(), label: 'Conseiller', titresConnaissance: [], ...over,
});

describe('le schéma', () => {
  it('🔴 ne porte QUE des noms : ni adresse, ni secret, ni gabarit de chemin', () => {
    // Un objet enrichi par le modèle voit ses clés inconnues tomber, ce qui est le comportement voulu de
    // `propositionSchema` : le pouvoir de l'assistant s'arrête au consentement.
    const r = propositionSchema.safeParse({ message: 'x', outilsBranches: ['erp_commandes'] });
    expect(r.success).toBe(true);
    expect(r.success && r.data.outilsBranches).toEqual(['erp_commandes']);
    // Une URL n'est pas un nom d'outil : elle ne passe pas le format.
    const avecUrl = propositionSchema.safeParse({ message: 'x', outilsBranches: ['https://autre.fr'] });
    expect(avecUrl.success).toBe(false);
  });

  it('⚠️ un nom mal formé est refusé, il n’est pas silencieusement nettoyé', () => {
    expect(propositionSchema.safeParse({ message: 'x', outilsDebranches: ['Erp Commandes'] }).success).toBe(false);
  });

  it('🔴 le schéma montré au modèle NOMME les deux champs, sinon ils ne seraient jamais remplis', () => {
    const src = readFileSync(resolve(__dirname, '../src/agent/setup/proposition.ts'), 'utf8');
    const schema = src.slice(src.indexOf('SCHEMA_PROPOSITION'));
    expect(schema).toContain('outilsBranches');
    expect(schema).toContain('outilsDebranches');
  });
});

describe('le diff', () => {
  it('propose de BRANCHER un outil du catalogue, en disant qu’il restera à activer', () => {
    const d = differences(COURANT(), { message: 'x', outilsBranches: ['erp_commandes'] });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ champ: 'outil.erp_commandes.rattachement', avant: 'non branché' });
    // 🔴 Le libellé ne dit JAMAIS « activé » : ce serait faux, et c'est le geste que 0086 réserve à l'humain.
    expect(d[0]?.apres).toContain('à activer');
    expect(d[0]?.label).not.toMatch(/activ[eé]/i);
  });

  it('🔴 REFUSE un outil absent du catalogue de l’espace : aucune ligne', () => {
    // L'existence n'est pas vérifiable par le schéma (il ne connaît pas le catalogue) : elle l'est ici. Une
    // ligne de diff sur un outil inexistant promettrait un branchement que l'application ne peut pas faire.
    expect(differences(COURANT(), { message: 'x', outilsBranches: ['outil_qui_n_existe_pas'] })).toEqual([]);
  });

  it('⚠️ brancher ce qui l’est déjà ne produit RIEN : ce n’est pas une modification', () => {
    expect(differences(COURANT(), { message: 'x', outilsBranches: ['chercher_connaissance'] })).toEqual([]);
    expect(differences(COURANT(), { message: 'x', outilsDebranches: ['erp_commandes'] })).toEqual([]);
  });

  it('🔴 débrancher DIT que la définition reste : sinon le client croit supprimer', () => {
    const d = differences(COURANT(), { message: 'x', outilsDebranches: ['chercher_connaissance'] });
    expect(d).toHaveLength(1);
    expect(d[0]?.apres).toMatch(/reste dans votre bibliothèque/);
  });
});

describe('ce que la route retient', () => {
  /**
   * 🔴 C'EST LE CONTRÔLE, ET IL EST SEUL DE SON ESPÈCE. Le schéma ne connaît pas la bibliothèque, donc il ne
   * peut pas refuser un nom inventé ; le diff ne fait que ne rien AFFICHER. Ce filtre-ci décide de ce qui
   * atteint l'application, c'est-à-dire de ce qui est réellement écrit.
   */
  it('🔴 un nom absent de la bibliothèque ne passe pas', () => {
    expect(brancheables(CATALOGUE, ['outil_qui_n_existe_pas'], false)).toEqual([]);
  });

  it('🔴 brancher ne retient que ce qui N’EST PAS branché, débrancher l’inverse', () => {
    // Sans cette symétrie, l'écran annoncerait un geste qui ne changerait rien, ou l'application tenterait
    // un rattachement que la base a déjà.
    expect(brancheables(CATALOGUE, ['erp_commandes', 'chercher_connaissance'], false)).toEqual(['erp_commandes']);
    expect(brancheables(CATALOGUE, ['erp_commandes', 'chercher_connaissance'], true)).toEqual(['chercher_connaissance']);
  });

  it('⚠️ un espace sans bibliothèque ne retient rien, et ne lève pas', () => {
    expect(brancheables(undefined, ['erp_commandes'], false)).toEqual([]);
    expect(brancheables(CATALOGUE, undefined, false)).toEqual([]);
  });
});

describe('ce que le modèle voit', () => {
  it('🔴 la bibliothèque de l’espace, avec l’état de branchement', () => {
    // La lui cacher reviendrait à lui demander de deviner un nom, donc à le pousser à en inventer un.
    const m = construireMessages(CTX(), [{ role: 'user', content: 'bonjour' }], { poses: [], reponses: [] });
    const texte = m[0]?.content ?? '';
    expect(texte).toContain('erp_commandes (État de commande) : pas branché');
    expect(texte).toContain('chercher_connaissance (Chercher dans la connaissance) : BRANCHÉ sur cet agent');
  });

  it('🔴 et le mandat lui dit qu’il ne peut PAS en créer', () => {
    const m = construireMessages(CTX(), [{ role: 'user', content: 'bonjour' }], { poses: [], reponses: [] });
    expect(m[0]?.content).toMatch(/Tu ne peux pas en CRÉER/);
  });

  it('⚠️ un espace sans bibliothèque le dit, plutôt que de ne rien dire', () => {
    const m = construireMessages(CTX({ catalogue: [] }), [{ role: 'user', content: 'x' }], { poses: [], reponses: [] });
    expect(m[0]?.content).toMatch(/Bibliothèque d’outils de l’espace : \(vide/);
  });
});

/**
 * 🔴 LE CÂBLAGE. Trois maillons, et chacun rend la capacité muette s'il manque : le catalogue doit être LU
 * côté serveur, la route doit le FILTRER, et le navigateur doit APPELER la route de rattachement. Un test
 * unitaire monte un faux câblage, il ne dit rien du vrai.
 */
describe('le vrai câblage', () => {
  const index = readFileSync(resolve(__dirname, '../src/index.ts'), 'utf8');
  const route = readFileSync(resolve(__dirname, '../src/http/agent-setup.ts'), 'utf8');
  const front = readFileSync(resolve(__dirname, '../web/lib/api-agent-setup.ts'), 'utf8');

  it('🔴 le catalogue de l’ESPACE est lu, pas les outils de l’agent', () => {
    // `listToutes(tenant, agentId)` ne connaît que les outils DÉJÀ branchés, c'est-à-dire justement pas ceux
    // que l'assistant peut proposer de brancher.
    expect(index).toContain('toolCatalog.listCatalogue(tenant)');
    expect(index).toContain('catalogue: catalogue.map(');
  });

  it('🔴 la route filtre sur la bibliothèque avant de rendre quoi que ce soit', () => {
    expect(route).toContain('outilsBranches: brancheables(ctx.etat.catalogue');
    expect(route).toContain('outilsDebranches: brancheables(ctx.etat.catalogue');
  });

  /**
   * 🔴 DEUX CHEMINS DANS DEUX FICHIERS, ET C'EST LEUR ÉCART QUI CASSE. La route s'appelle `/tools` côté
   * serveur ; le navigateur l'avait recopiée `/outils`, et le branchement rendait 404 à chaque fois, avec un
   * message parlant d'un outil « qui n'a pas pu être enregistré ». Aucun test unitaire ne pouvait le voir :
   * ils montent tous le module Fastify directement. Seule une sonde sur la PRODUCTION l'a montré.
   */
  it('🔴 le chemin du navigateur est celui du serveur, segment pour segment', () => {
    const serveurTools = readFileSync(resolve(__dirname, '../src/http/agent-tools.ts'), 'utf8');
    const frontTools = readFileSync(resolve(__dirname, '../web/lib/api-agent-tools.ts'), 'utf8');
    const segment = /const base = '\/tenants\/:tenantId\/agents\/:agentId\/([a-z]+)'/.exec(serveurTools)?.[1];
    expect(segment).toBe('tools');
    expect(frontTools).toContain(`/agents/${'$'}{agentId}/${segment}`);
    // Et AUCUN chemin écrit à la main à côté du constructeur commun.
    expect(frontTools).not.toContain('/agents/${agentId}/outils');
  });

  it('🔴 le navigateur APPELLE la route de rattachement', () => {
    expect(front).toContain('rattacherOutil(tenantId, agentId, id, true)');
    expect(front).toContain('rattacherOutil(tenantId, agentId, id, false)');
    // Les noms se résolvent sur la BIBLIOTHÈQUE : un outil à brancher n'est pas encore sur l'agent.
    expect(front).toContain('getBibliothequeOutils(tenantId)');
  });
});
