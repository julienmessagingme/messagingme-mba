import { describe, it, expect } from 'vitest';
import { lireVariables, paramsDuConnecteur, type RequeteConnecteur, type VariableDeclaree } from '../src/agent/requetes';
import { toolParamsToJsonSchema } from '../src/agent/llm/tool-schema';
import { versOutil } from '../src/agent/catalog.pg';
import { outilExpose } from '../src/agent/outils-maison';
import { executeTool } from '../src/agent/executor';
import { creerResolveurHttp } from '../src/agent/resolvers/http';
import { JOURNAL_MUET } from '../src/agent/journal-muet';
import type { OutilDefini } from '../src/agent/catalog';
import type { SourceAppel } from '../src/agent/sources';
import { GESTE_MUET } from './gestes';

/**
 * CE QUE LE MODÈLE REMPLIT POUR UN APPEL DE CONNECTEUR SE LIT SUR SA REQUÊTE, À CHAQUE LECTURE (2026-10-08).
 *
 * 🔴 LE DÉFAUT. La création d'un outil recopiait les variables « décidée par l'agent » de la requête dans
 * `agent_tools.params`, et rien ne rafraîchissait la copie. Le schéma envoyé au modèle et la validation des arguments
 * lisaient la copie, le résolveur lisait la requête. Sur Groupama PJ, `age_mois` renommée `age` dans Tools >
 * Connecteurs API : l'agent IA remplissait `age_mois`, et chaque appel était refusé (« information manquante »),
 * sans rien à l'écran, jusqu'à ce qu'on supprime et recrée l'outil.
 *
 * 🔴 LA PARADE. Plus de copie : le catalogue relit les variables de la requête avec l'outil (`COLONNES`), et
 * `versOutil` en dérive les paramètres par `paramsDuConnecteur`, après la même relecture que le résolveur
 * (`lireVariables`). Le SQL est éprouvé par `tests/integration/connecteur-suit-sa-requete.integration.test.ts` ; ce
 * fichier fait traverser une LIGNE de base jusqu'à l'appel réseau, sans base.
 */

const SOURCE: SourceAppel = {
  id: 'src1', kind: 'http', baseUrl: 'https://api.client.fr/v1',
  authKind: 'none', authHeaderName: null, authSecret: null, status: 'active',
};

/** La requête « tarif » de Groupama PJ, avant et après le renommage, plus ce que la modification a aussi changé. */
const AVANT: VariableDeclaree[] = [
  { nom: 'espece', type: 'string', origine: { type: 'modele' }, requis: true, enum: ['chien', 'chat'] },
  { nom: 'race', type: 'string', origine: { type: 'modele' }, requis: true },
  { nom: 'age_mois', type: 'integer', origine: { type: 'modele' }, requis: true, description: 'âge en mois' },
  // Le numéro vient du tour, jamais du modèle : c'est la garde anti-IDOR, elle doit survivre à la dérivation.
  { nom: 'tel', type: 'string', origine: { type: 'fiche', cle: 'wa_id' } },
];
const APRES: VariableDeclaree[] = [
  { nom: 'espece', type: 'string', origine: { type: 'modele' }, requis: true, enum: ['chien', 'chat', 'lapin'] },
  { nom: 'race', type: 'string', origine: { type: 'modele' }, requis: true },
  { nom: 'age', type: 'integer', origine: { type: 'modele' }, requis: true, description: 'âge en années' },
  { nom: 'tel', type: 'string', origine: { type: 'fiche', cle: 'wa_id' } },
];

const requete = (variables: VariableDeclaree[]): RequeteConnecteur => ({
  id: 'rq1', tenantId: 't1', sourceId: 'src1', label: 'tarif', methode: 'GET', chemin: '/tarif',
  parametres: [
    { cle: 'espece', valeur: '{{espece}}' }, { cle: 'race', valeur: '{{race}}' },
    { cle: 'age', valeur: '{{age}}' }, { cle: 'tel', valeur: '{{tel}}' },
  ],
  entetes: [], corps: { mode: 'aucun' }, variables, outputPaths: ['prix'], valeursTest: {}, outils: 1,
  updatedAt: '2026-10-08T09:43:00.000Z',
});

/** Ce que la création d'un outil recopiait jusqu'au 2026-10-08 (`src/http/agent-tools.ts`, la même dérivation). */
const copieDe = (variables: VariableDeclaree[]): unknown => paramsDuConnecteur(variables);

/** Une ligne d'`agent_tools` telle que `PgToolCatalog` la lit, sa requête jointe. */
const ligne = (params: unknown, requeteVariables: unknown): Parameters<typeof versOutil>[0] => ({
  id: 'to1', tenant_id: 't1', origin: 'http', name: 'obtenir_tarif', description: 'donne le tarif',
  ne_pas_utiliser: '', params, binding: {}, source_id: 'src1', request_id: 'rq1', output_paths: ['prix'],
  nature: 'integre', risk: 'read', mcp_annonce: null, mcp_non_activable: null, mcp_indisponible_le: null,
  mcp_vu_le: null, timeout_ms: 5_000, max_bytes: 16_384, autonome: false, gestes: [],
  requete_variables: requeteVariables,
});

/** Un appel de l'outil par le modèle, par le tronc commun et le VRAI résolveur ; le réseau est simulé. */
async function appeler(outil: OutilDefini, requeteCourante: RequeteConnecteur, args: Record<string, unknown>) {
  const parties: string[] = [];
  const resolveur = creerResolveurHttp({
    sources: { pourAppel: async () => SOURCE, marquerEpreuve: async () => {} },
    requetes: { parId: async () => requeteCourante },
    fiche: { ficheDuContact: async () => null },
    fetchImpl: (async (url: string) => {
      parties.push(String(url));
      return new Response(JSON.stringify({ prix: 12.5 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch,
    verifierResolution: async () => ({ ok: true }),
  });
  const r = await executeTool(
    { name: outil.name, argumentsJson: JSON.stringify(args) },
    {
      tenantId: 't1', agentId: 'ag1', sessionId: 's1', runId: 'r1', workflowId: 'wf1', waId: '33600',
      contact: null, contactInconnu: 'tous', appelsRestants: 5, budgetRestantMicroEur: 10_000,
      deadline: Date.now() + 30_000,
    },
    {
      catalogue: { byName: async () => outil, listActifs: async () => [outil] },
      journal: JOURNAL_MUET, resolveurs: { http: resolveur }, sessions: { compterAppel: async () => {} },
      executerGeste: GESTE_MUET,
    },
  );
  return { r, parties };
}

describe('ce que le modèle voit d’un appel de connecteur : les variables « décidée par l’agent » de sa requête', () => {
  it('🔴 seules les variables du modèle sont exposées (la garde anti-IDOR des deux routes de création)', () => {
    /**
     * Le cas des deux tests de route qui gardaient la copie (`tests/http-agent-tools.test.ts`,
     * `tests/http-mba-outils.test.ts`), conservé ici puisque la dérivation a quitté les routes : un champ du mini-CRM,
     * une valeur système et le numéro (sous son ANCIENNE forme `contact:wa_id`, relue par `lireVariables`) sont
     * résolus par le serveur. Les exposer inviterait le modèle à les fournir, donc à désigner la ressource d'un autre.
     */
    const variables = lireVariables([
      { nom: 'ref', type: 'string', origine: { type: 'modele' }, requis: true },
      { nom: 'ville', type: 'string', origine: { type: 'champ', cle: 'ville' } },
      { nom: 'dit', type: 'string', origine: { type: 'systeme', cle: 'derniere_saisie' } },
      { nom: 'numero', type: 'string', origine: { type: 'contact', cle: 'wa_id' } },
    ]);
    expect(variables.map((v) => v.nom)).toEqual(['ref', 'ville', 'dit', 'numero']);
    expect(paramsDuConnecteur(variables)).toEqual([{ name: 'ref', type: 'string', source: 'modele', required: true }]);
    expect(toolParamsToJsonSchema(paramsDuConnecteur(variables))).toEqual({
      type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false,
    });
  });

  it('porte le type, la description, l’obligation et les valeurs permises de chaque variable', () => {
    expect(paramsDuConnecteur([
      { nom: 'age', type: 'integer', origine: { type: 'modele' }, requis: true, description: 'âge en années' },
      { nom: 'espece', type: 'string', origine: { type: 'modele' }, enum: ['chien', 'chat'] },
      // Une liste vide veut dire « libre » : elle ne devient pas une énumération vide, que rien ne satisferait.
      { nom: 'note', type: 'string', origine: { type: 'modele' }, enum: [] },
    ])).toEqual([
      { name: 'age', type: 'integer', source: 'modele', description: 'âge en années', required: true },
      { name: 'espece', type: 'string', source: 'modele', enum: ['chien', 'chat'] },
      { name: 'note', type: 'string', source: 'modele' },
    ]);
  });

  it('une requête illisible ou absente ne donne aucun paramètre', () => {
    expect(paramsDuConnecteur(lireVariables(null))).toEqual([]);
    expect(paramsDuConnecteur(lireVariables({ nom: 'pas un tableau' }))).toEqual([]);
  });
});

describe('après un renommage dans Tools > Connecteurs API, l’outil d’un agent IA appelle avec le nouveau nom', () => {
  it('🔴 le défaut, mesuré : la copie prise avant le renommage fait refuser chaque appel', async () => {
    // Ce que l'agent de Groupama PJ faisait le 2026-10-08 : il voit `age_mois` dans la copie et la remplit, le
    // résolveur lit la requête modifiée et ne trouve pas `age`. Ce cas ne garde pas le correctif, il montre
    // pourquoi aucune copie ne peut marcher : elle est fausse dès la première modification. L'outil est celui que
    // l'ancien `versOutil` rendait : ses paramètres sont la colonne, donc la copie.
    const copie: OutilDefini = { ...versOutil(ligne(copieDe(AVANT), APRES)), params: copieDe(AVANT) };
    const { r, parties } = await appeler(copie, requete(APRES), { espece: 'chien', race: 'labrador', age_mois: 36 });
    expect(r.status).toBe('erreur_outil');
    expect(JSON.stringify(r.contenu)).toContain('information manquante');
    expect(JSON.stringify(r.contenu)).toContain('age');
    expect(parties).toEqual([]);
  });

  it('🔴 une ligne lue en base expose la requête COURANTE, et l’appel part avec `age`', async () => {
    // La ligne porte encore la copie d'avant (les outils créés avant le correctif la gardent) : elle ne doit plus
    // compter. Le modèle voit ce que la requête déclare aujourd'hui, la validation l'accepte, le résolveur l'envoie.
    const outil = versOutil(ligne(copieDe(AVANT), APRES));
    const vu = outilExpose(outil, [])!.parameters;
    expect(Object.keys(vu.properties)).toEqual(['espece', 'race', 'age']);
    expect(vu.required).toEqual(['espece', 'race', 'age']);
    expect(vu.properties.espece!.enum).toEqual(['chien', 'chat', 'lapin']);
    expect(vu.properties.age!.description).toBe('âge en années');
    expect(vu.properties).not.toHaveProperty('tel');

    const { r, parties } = await appeler(outil, requete(APRES), { espece: 'lapin', race: 'nain', age: 3 });
    expect(r.status).toBe('ok');
    expect(r.contenu).toEqual({ prix: 12.5 });
    expect(parties).toHaveLength(1);
    const envoye = new URL(parties[0]!).searchParams;
    expect(envoye.get('age')).toBe('3');
    expect(envoye.get('espece')).toBe('lapin');
    // Le numéro vient du tour, pas des arguments du modèle.
    expect(envoye.get('tel')).toBe('33600');
  });

  it('⚠️ un outil maison ou MCP garde sa propre liste : seul un connecteur API suit sa requête', () => {
    // Les paramètres d'un outil MCP portent des sources que le client règle (`contact`, `champ`, `fixe`) et ceux d'un
    // outil maison des valeurs permises réglables : la colonne fait foi pour eux, même si une requête traînait.
    const propres = [{ name: 'q', type: 'string', source: 'modele' }];
    expect(versOutil({ ...ligne(propres, APRES), origin: 'mcp' }).params).toEqual(propres);
    expect(versOutil({ ...ligne(propres, APRES), origin: 'mba' }).params).toEqual(propres);
  });
});
