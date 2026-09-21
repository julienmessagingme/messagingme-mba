import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { vueOutilMba, type ContexteVue } from '../src/mba/vue-outils';
import { outilsAPublier } from '../src/mba/outils-a-publier';
import { HANDLERS_MAISON_MBA, typeDeLaCible, type CibleMaison, type HandlerMaisonMba } from '../src/mba/outils-maison';
import { BORNES_OUTIL_MBA, TYPES_SAISISSABLES } from '../src/http/mba-outils';
import { NOM_CONNECTEUR_RELAIS } from '../src/mba/publication';
import type { OutilComplet } from '../src/agent/catalog';

/**
 * LA PARITÉ ENTRE LE SERVEUR ET L'ÉCRAN DE L'ONGLET « OUTILS » DE L'AGENT DE META (spec 2026-09-21, § 3).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : quatre listes vivent en double, et chacune ne casse que par son ÉCART.
 * `web/lib/api-mba-outils.ts` se déclare le miroir de `src/mba/vue-outils.ts` ; `ChoixTypeOutil.tsx` propose des
 * types que `src/http/mba-outils.ts` doit accepter ; et « ✓ Chez Meta » n'est vrai que si `publiable` dit la même
 * chose que `outilsAPublier`. Le lot 3 ajoute « bloc » et « scénario » aux quatre endroits : sans ce test, en
 * oublier un compilerait.
 */
const racine = resolve(__dirname, '..');
const lire = (chemin: string): string => readFileSync(resolve(racine, chemin), 'utf8');

/** Les littéraux `'xxx'` d'un `export type Nom = ...` qui tient sur une ligne. */
function unionSurUneLigne(src: string, nom: string): string[] {
  const m = new RegExp(`export type ${nom} = ([^;\\n]+);`).exec(src);
  expect(m, `export type ${nom} introuvable`).not.toBeNull();
  return [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!).sort();
}

/** Les `type: 'xxx'` d'une union d'objets écrite sur plusieurs lignes, jusqu'à la ligne vide qui la clôt. */
function typesDUnionDObjets(src: string, nom: string): string[] {
  const debut = src.indexOf(`export type ${nom} =`);
  expect(debut, `export type ${nom} introuvable`).toBeGreaterThanOrEqual(0);
  const bloc = src.slice(debut, src.indexOf('\n\n', debut));
  return [...bloc.matchAll(/type: '([a-z_]+)'/g)].map((x) => x[1]!).sort();
}

/** Les noms de champs d'une `export interface`, commentaires retirés. */
function champsDInterface(src: string, nom: string): string[] {
  const debut = src.indexOf(`export interface ${nom} {`);
  expect(debut, `export interface ${nom} introuvable`).toBeGreaterThanOrEqual(0);
  const corps = src.slice(debut, src.indexOf('\n}', debut)).replace(/\/\*[\s\S]*?\*\//g, '');
  return [...corps.matchAll(/^\s+([a-zA-Z]+)\??:/gm)].map((x) => x[1]!).sort();
}

const serveurVue = lire('src/mba/vue-outils.ts');
const serveurMaison = lire('src/mba/outils-maison.ts');
const web = lire('web/lib/api-mba-outils.ts');
const choix = lire('web/components/mba-outils/ChoixTypeOutil.tsx');

describe('les types, des deux côtés', () => {
  it('🔴 le type d’un outil est le même union au serveur et à l’écran', () => {
    expect(unionSurUneLigne(web, 'TypeOutilMba')).toEqual(unionSurUneLigne(serveurMaison, 'TypeOutilMba'));
  });

  it('🔴 la ligne d’un outil porte les mêmes champs des deux côtés', () => {
    // C'est ce qui a manqué à `publiable` : un champ ajouté d'un seul côté vaut `undefined` de l'autre, sans erreur.
    expect(champsDInterface(web, 'OutilMbaVue')).toEqual(champsDInterface(serveurVue, 'OutilMbaVue'));
    expect(typesDUnionDObjets(web, 'CibleVue')).toEqual(typesDUnionDObjets(serveurVue, 'CibleVue'));
  });

  it('🔴 ce que l’écran SAISIT est exactement ce que la route accepte', () => {
    expect(typesDUnionDObjets(web, 'CibleSaisie')).toEqual([...TYPES_SAISISSABLES].sort());
  });

  it('🔴 tout type PROPOSÉ à l’écran est accepté par la route : sinon, un bouton qui rend 400', () => {
    const m = /TYPES_PROPOSES: readonly TypeOutilMba\[\] = \[([^\]]*)\]/.exec(choix);
    expect(m).not.toBeNull();
    const proposes = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
    expect(proposes.length).toBeGreaterThan(0);
    for (const type of proposes) expect(TYPES_SAISISSABLES).toContain(type);
  });

  it('🔴 chaque geste maison se CRÉE depuis l’écran', () => {
    // Un `Record` sur les handlers : le lot 3 ne compile pas tant qu'il n'a pas donné un exemple de ses cibles.
    const EXEMPLES: Record<HandlerMaisonMba, CibleMaison> = {
      tag_fixe: { handler: 'tag_fixe', tag: 'vip' },
      champ_fixe: { handler: 'champ_fixe', champ: 'ville', valeurs: [] },
    };
    for (const h of HANDLERS_MAISON_MBA) expect(TYPES_SAISISSABLES).toContain(typeDeLaCible(EXEMPLES[h]));
  });
});

describe('les constantes recopiées dans l’écran', () => {
  const ecranLib = lire('web/lib/mba-outils.ts');
  const onglet = lire('web/components/mba-outils/OutilsMba.tsx');

  it('🔴 les bornes de la saisie sont celles de la route', () => {
    // Plus basses à l'écran, un client ne pourrait pas écrire ce que la route accepte ; plus hautes, il écrirait
    // pour recevoir un 400.
    const m = /export const BORNES_OUTIL = (\{[^}]*\})/.exec(ecranLib);
    expect(m).not.toBeNull();
    const ecran = Object.fromEntries([...m![1]!.matchAll(/(\w+):\s*(\d+)/g)].map((x) => [x[1]!, Number(x[2])]));
    expect(ecran).toEqual({ ...BORNES_OUTIL_MBA });
  });

  it('🔴 le connecteur attendu dans un effacement est celui que la publication pose chez Meta', () => {
    // Recopié de travers, le dernier retrait déclencherait la confirmation « effacement imprévu » sur notre
    // propre connecteur.
    const m = /const CONNECTEUR_RELAIS = '([^']+)'/.exec(onglet);
    expect(m?.[1]).toBe(NOM_CONNECTEUR_RELAIS);
  });
});

describe('« ✓ Chez Meta » ne se dit que de ce qui part chez Meta', () => {
  const outil = (over: Partial<OutilComplet>): OutilComplet => ({
    id: 'o1', tenantId: 't1', origin: 'mba', name: 'n', description: 'd', nePasUtiliser: 'p', gestes: [], params: [],
    binding: {}, sourceId: null, requestId: null, nature: 'integre', outputPaths: [], risk: 'write', timeoutMs: 5000,
    maxBytes: 16384, autonome: false, mcpAnnonce: null, mcpNonActivable: null, mcpIndisponibleLe: null, mcpVuLe: null,
    title: 'T', actif: true, activeLe: null, autonomeLe: null, ...over,
  });
  const ctx: ContexteVue = {
    requetes: new Map([['rq1', { label: 'Poser une étiquette' }]]), champs: new Set(['ville']), bibliotheque: new Map(),
  };
  const requete = async (id: string) => (ctx.requetes.has(id) ? { variables: [] } : null);

  const CAS: Array<[string, OutilComplet]> = [
    ['un tag', outil({ binding: { handler: 'tag_fixe', tag: 'vip' } })],
    ['un champ', outil({ binding: { handler: 'champ_fixe', champ: 'ville', valeurs: [] } })],
    // Publié quand même : le relais refuse l'appel, et la ligne rouge le dit.
    ['un champ supprimé du mini-CRM', outil({ binding: { handler: 'champ_fixe', champ: 'disparu', valeurs: [] } })],
    ['un connecteur', outil({ origin: 'http', requestId: 'rq1' })],
    ['un connecteur dont l’appel est supprimé', outil({ origin: 'http', requestId: 'rq9' })],
    ['un connecteur sans appel', outil({ origin: 'http', requestId: null })],
    ['un outil MCP', outil({ origin: 'mcp', sourceId: 's1' })],
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
