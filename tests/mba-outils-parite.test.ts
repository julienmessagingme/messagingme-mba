import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { vueOutilMba, type ContexteVue } from '../src/mba/vue-outils';
import { outilsAPublier } from '../src/mba/outils-a-publier';
import { HANDLERS_MAISON_MBA, typeDeLaCible, type CibleMaison, type HandlerMaisonMba } from '../src/mba/outils-maison';
import { TYPES_SAISISSABLES } from '../src/http/mba-outils';
import { BORNES_OUTIL_MBA, TYPES_OUTIL_MBA } from '../web/lib/partage/outils-mba';
import { LONGUEUR_MAX_ETIQUETTE } from '../src/crm/poser-etiquette';
import { NOM_CONNECTEUR_RELAIS } from '../src/mba/publication';
import { METHODES, risqueSelonMethode } from '../src/agent/http-cible';
import type { OutilComplet } from '../src/agent/catalog';

/** Le contrat partagé couvre les formes ; ces tests gardent les règles exécutées aux frontières. */
const racine = resolve(__dirname, '..');
const lire = (chemin: string): string => readFileSync(resolve(racine, chemin), 'utf8');

const WF = '11111111-1111-4111-8111-111111111111';
const CODE = `nod_abc_${'A'.repeat(26)}`;

describe('le contrat partagé des outils de Meta', () => {
  it('la route accepte exactement les types proposés par le contrat', () => {
    expect(TYPES_SAISISSABLES).toEqual(TYPES_OUTIL_MBA);
  });

  it('la borne des étiquettes reste celle du CRM', () => {
    expect(BORNES_OUTIL_MBA.tag).toBe(LONGUEUR_MAX_ETIQUETTE);
  });

  it('🔴 chaque geste maison se CRÉE depuis l’écran', () => {
    // Un `Record` sur les handlers : le lot 3 ne compile pas tant qu'il n'a pas donné un exemple de ses cibles.
    const EXEMPLES: Record<HandlerMaisonMba, CibleMaison> = {
      tag_fixe: { handler: 'tag_fixe', tag: 'vip' },
      champ_fixe: { handler: 'champ_fixe', champ: 'ville', valeurs: [] },
      bloc_fixe: { handler: 'bloc_fixe', workflowId: WF, code: CODE },
      scenario_fixe: { handler: 'scenario_fixe', workflowId: WF },
    };
    for (const h of HANDLERS_MAISON_MBA) expect(TYPES_SAISISSABLES).toContain(typeDeLaCible(EXEMPLES[h]));
  });
});

describe('les autres constantes recopiées dans l’écran', () => {
  const ecranLib = lire('web/lib/mba-outils.ts');

  it('🔴 les méthodes dites « irréversibles » à l’écran sont celles que le serveur range ainsi', () => {
    // Sinon l'écran annoncerait un appel sans danger que le serveur traite comme irréversible, ou l'inverse.
    // La liste des méthodes est celle du serveur, pas une recopie : une méthode ajoutée y serait vue.
    const serveur = METHODES.filter((m) => risqueSelonMethode(m) === 'irreversible');
    const m = /export const METHODES_IRREVERSIBLES: readonly string\[\] = \[([^\]]*)\]/.exec(ecranLib);
    expect(m).not.toBeNull();
    expect([...m![1]!.matchAll(/'([A-Z]+)'/g)].map((x) => x[1]!)).toEqual(serveur);
  });

  it('🔴 le connecteur attendu dans un effacement est celui que la publication pose chez Meta', () => {
    // Recopié de travers, le dernier retrait déclencherait la confirmation « effacement imprévu » sur notre
    // propre connecteur.
    const m = /export const CONNECTEUR_RELAIS = '([^']+)'/.exec(ecranLib);
    expect(m?.[1]).toBe(NOM_CONNECTEUR_RELAIS);
  });
});

describe('« ✓ Chez Meta » ne se dit que de ce qui part chez Meta', () => {
  const outil = (over: Partial<OutilComplet>): OutilComplet => ({
    id: 'o1', tenantId: 't1', origin: 'mba', name: 'n', description: 'd', nePasUtiliser: 'p', gestes: [], params: [],
    binding: {}, sourceId: null, requestId: null, nature: 'integre', outputPaths: [], risk: 'write', timeoutMs: 5000,
    maxBytes: 16384, autonome: false, mcpAnnonce: null, mcpNonActivable: null, mcpIndisponibleLe: null, mcpVuLe: null,
    title: 'T', actif: true, activeLe: null, autonomeLe: null, inappelable: null, ...over,
  });
  const ctx: ContexteVue = {
    requetes: new Map([['rq1', { label: 'Poser une étiquette' }]]), champs: new Set(['ville']), bibliotheque: new Map(),
    workflows: new Map([[WF, { name: 'Accueil', graph: {
      nodes: [{ id: 'n1', type: 'quick_message', position: { x: 0, y: 0 }, data: { code: CODE, body: 'Brochure', quickReplies: [] } }],
      edges: [],
    } }]]),
    serveurs: new Map(),
  };
  const requete = async (id: string) => (ctx.requetes.has(id) ? { variables: [] } : null);

  const CAS: Array<[string, OutilComplet]> = [
    ['un tag', outil({ binding: { handler: 'tag_fixe', tag: 'vip' } })],
    ['un champ', outil({ binding: { handler: 'champ_fixe', champ: 'ville', valeurs: [] } })],
    // Publié quand même : le relais refuse l'appel, et la ligne rouge le dit.
    ['un champ supprimé du mini-CRM', outil({ binding: { handler: 'champ_fixe', champ: 'disparu', valeurs: [] } })],
    ['un bloc', outil({ binding: { handler: 'bloc_fixe', workflowId: WF, code: CODE } })],
    // Publié quand même, comme un champ supprimé : le relais refuse chaque appel, et la ligne rouge le dit.
    ['un bloc dont le scénario est supprimé', outil({ binding: { handler: 'bloc_fixe', workflowId: '99999999-9999-4999-8999-999999999999', code: CODE } })],
    ['un scénario', outil({ binding: { handler: 'scenario_fixe', workflowId: WF } })],
    ['un connecteur', outil({ origin: 'http', requestId: 'rq1' })],
    ['un connecteur dont l’appel est supprimé', outil({ origin: 'http', requestId: 'rq9' })],
    ['un connecteur sans appel', outil({ origin: 'http', requestId: null })],
    ['un outil MCP', outil({ origin: 'mcp', sourceId: 's1' })],
    // L'inappelabilité vient du catalogue (la règle unique du 2026-10-02), pour les deux familles qui ont une source.
    ['un outil MCP non activable', outil({ origin: 'mcp', sourceId: 's1', inappelable: { cause: 'non_activable', detail: 'schéma illisible' } })],
    ['un outil MCP disparu de son serveur', outil({ origin: 'mcp', sourceId: 's1', inappelable: { cause: 'disparu' } })],
    ['un outil MCP dont le serveur est éteint', outil({ origin: 'mcp', sourceId: 's1', inappelable: { cause: 'source_inactive' } })],
    ['un connecteur dont la source est éteinte', outil({ origin: 'http', requestId: 'rq1', inappelable: { cause: 'source_inactive' } })],
    ['une action d’agent IA', outil({ binding: { handler: 'poser_tag' } })],
    ['un outil maison illisible', outil({ binding: { handler: 'tag_fixe', tag: 'vip', intrus: 1 } })],
  ];

  it.each(CAS)('%s : `publiable` dit ce que fait la publication', async (_nom, o) => {
    const publie = (await outilsAPublier([o], requete)).length === 1;
    expect(vueOutilMba(o, ctx).publiable).toBe(publie);
  });

  it('⚠️ les cas couvrent les deux réponses, sinon la parité ne prouverait rien', async () => {
    const reponses = await Promise.all(CAS.map(async ([, o]) => (await outilsAPublier([o], requete)).length === 1));
    expect(new Set(reponses)).toEqual(new Set([true, false]));
  });
});
