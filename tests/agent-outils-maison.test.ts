import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  HANDLERS_A_CIBLE, OUTILS_MAISON, lireCibleOutilAgent, outilExpose, outilMaison, outilsExposes, paramsEffectifs, paramsInitiaux,
} from '../src/agent/outils-maison';
import { HANDLERS_MAISON } from '../src/agent/resolvers/mba';
import { creerResolveurSimulation } from '../src/agent/resolvers/simulation';
import { OUTILS_SURS } from '../src/agent/reglages';
import type { OutilDefini } from '../src/agent/catalog';
import { SANS_MCP } from './outils-mcp';
import { AUCUN_GESTE } from './gestes';

/**
 * Le catalogue des outils maison, et ce que le modèle voit d'un outil.
 *
 * 🔴 LE TEST QUI COMPTE ICI est celui de l'énumération de `terminer`. C'est le défaut relevé par la revue de
 * la tâche 18 : les règles d'arrêt vivent sur la FICHE (c'est de là que le builder tire les handles du bloc),
 * et les recopier dans `agent_tools.params` créerait une seconde vérité. Elle divergerait au premier ajout de
 * règle, et le modèle terminerait alors par une sortie que le bloc ne dessine pas, donc par une conversation
 * qui remonte en inbox sans que personne comprenne pourquoi.
 */

const outil = (params: unknown, handler = 'terminer', binding: Record<string, unknown> = { handler }): OutilDefini => ({ ...SANS_MCP, ...AUCUN_GESTE(),
  id: 'o1', tenantId: 't1', origin: 'mba', name: 'mba_terminer',
  description: 'Termine.', params, binding, sourceId: null, requestId: null, nePasUtiliser: '', nature: 'integre' as const, outputPaths: [], risk: 'read',
  timeoutMs: 8000, maxBytes: 16384, autonome: false,
});

/** Des cibles valides (RC4), telles que la pose les écrit dans `binding`. */
const WF = '0b7e2c1a-4d5e-4f60-8a9b-1c2d3e4f5a6b';
const CIBLE_TAG = { handler: 'poser_tag', tag: 'vip' };
const cibleChamp = (valeurs: string[]) => ({ handler: 'ecrire_variable', champ: 'statut', valeurs });
const CIBLE_BLOC = { handler: 'envoyer_bloc', workflowId: WF, code: 'nod_t1_01HZX5Y6Z7A8B9C0D1E2F3G4H5' };
const CIBLE_SCENARIO = { handler: 'lancer_scenario', workflowId: WF };

describe('catalogue des outils maison', () => {
  it('🔴 le catalogue et les handlers du résolveur se correspondent EXACTEMENT', () => {
    // Un handler sans entrée au catalogue est inatteignable depuis la console ; une entrée sans handler
    // produit un outil actif, exposé au modèle, qui refuse à chaque appel.
    expect([...OUTILS_MAISON.map((o) => o.handler)].sort()).toEqual([...HANDLERS_MAISON].sort());
  });

  it('chaque outil porte des mots, un risque, et un nom exposé valide', () => {
    for (const o of OUTILS_MAISON) {
      // Le charset est celui du `check` de la migration 0086, commun à OpenAI et Gemini.
      expect(o.nomDefaut, o.handler).toMatch(/^[a-z0-9_]{1,64}$/);
      expect(o.titre.fr.length, o.handler).toBeGreaterThan(0);
      expect(o.titre.en.length, o.handler).toBeGreaterThan(0);
      expect(o.description.fr.length, o.handler).toBeGreaterThan(10);
      expect(o.description.en.length, o.handler).toBeGreaterThan(10);
      expect(['read', 'write', 'irreversible']).toContain(o.risk);
    }
  });

  it('🔴 envoyer un bloc est IRRÉVERSIBLE, donc soumis à l’autonomie', () => {
    // Un message parti chez un contact ne se rappelle pas, et il est facturé. Le tronc commun refuse alors
    // l'appel tant que le client n'a pas coché l'autonomie sur cet outil : c'est ce qui rend ce drapeau
    // vivant dès maintenant, au lieu d'un réglage en sommeil jusqu'aux familles HTTP et MCP.
    expect(outilMaison('envoyer_bloc')?.risk).toBe('irreversible');
  });

  it('🔴 « marquer la conversation urgente » (RC2) : une écriture sans paramètre, hors des outils sûrs du MCP', () => {
    const urgent = outilMaison('marquer_urgent');
    expect(urgent?.nomDefaut).toBe('mba_marquer_urgent');
    expect(urgent?.risk).toBe('write');
    // Aucun paramètre : le modèle ne peut désigner aucune autre conversation que celle du tour.
    expect(urgent?.params).toEqual([]);
    expect(urgent?.paramsImposes).toBeUndefined();
    expect(urgent?.nePasUtiliser.fr).toBe('Ne pas l’appeler pour une simple demande d’information.');
    // Décision par défaut du plan : un agent tiers ne le pose pas par MCP, le client l'ajoute à la main.
    expect((OUTILS_SURS as readonly string[]).includes('marquer_urgent')).toBe(false);
  });

  it('🔴 le bac à sable SIMULE l’urgence : aucune conversation réelle n’est marquée, l’agent continue', async () => {
    // Le résolveur du bac à sable ne reçoit aucune dépendance d'écriture : il ne peut rien marquer, et il le dit au
    // modèle, sans `rendu` ni `sortie`.
    const simulation = creerResolveurSimulation({ connaissance: { chercher: async () => [] } });
    const r = await simulation({
      outil: outil([], 'marquer_urgent'), args: {}, signal: new AbortController().signal,
      ctx: {
        tenantId: 't1', agentId: 'ag1', sessionId: 's1', runId: 'r1', workflowId: 'wf1', waId: 'bac-a-sable', contact: null,
        contactInconnu: 'tous', appelsRestants: 5, budgetRestantMicroEur: 10_000, deadline: Date.now() + 30_000,
      },
    });
    expect(r.ok).not.toBe(false);
    expect(r.contenu).toMatchObject({ simule: true });
    expect(r).not.toHaveProperty('rendu');
    expect(r).not.toHaveProperty('sortie');
  });

  it('🔴 le bac à sable connaît CHAQUE outil du catalogue : un oubli y refuserait l’outil à chaque essai', async () => {
    const simulation = creerResolveurSimulation({ connaissance: { chercher: async () => [] } });
    for (const o of OUTILS_MAISON) {
      const r = await simulation({
        outil: outil([], o.handler), args: {}, signal: new AbortController().signal,
        ctx: {
          tenantId: 't1', agentId: 'ag1', sessionId: 's1', runId: 'r1', workflowId: 'wf1', waId: 'bac-a-sable', contact: null,
          contactInconnu: 'tous', appelsRestants: 5, budgetRestantMicroEur: 10_000, deadline: Date.now() + 30_000,
        },
      });
      expect(r.erreur, o.handler).not.toBe('handler inconnu');
    }
  });

  it('🔴 RC4 : les outils à cible n’exposent au modèle AUCUN paramètre qui désigne la cible', () => {
    // Le tag, le bloc et le scénario sont fixés à la pose : le modèle ne choisit que le moment. Le champ aussi ; seule la
    // valeur vient de lui.
    expect(outilMaison('poser_tag')?.params).toEqual([]);
    expect(outilMaison('envoyer_bloc')?.params).toEqual([]);
    expect(outilMaison('lancer_scenario')?.params).toEqual([]);
    expect(outilMaison('ecrire_variable')?.params.map((p) => p.name)).toEqual(['valeur']);
    expect(HANDLERS_A_CIBLE.slice().sort()).toEqual(['ecrire_variable', 'envoyer_bloc', 'lancer_scenario', 'poser_tag']);
  });

  it('🔴 RC4 : « lancer un scénario » est irréversible, et hors des outils sûrs du MCP', () => {
    const lancer = outilMaison('lancer_scenario');
    expect(lancer?.nomDefaut).toBe('mba_lancer_scenario');
    expect(lancer?.risk).toBe('irreversible');
    expect((OUTILS_SURS as readonly string[]).includes('lancer_scenario')).toBe(false);
    // Aucun outil sûr n'exige de cible : `set_agent_tools` ne pourrait pas en donner une.
    expect(OUTILS_SURS.filter((h) => (HANDLERS_A_CIBLE as readonly string[]).includes(h))).toEqual([]);
  });

  it('🔴 RC4 : la cible se lit en `.strict()`, et son handler en fait partie', () => {
    expect(lireCibleOutilAgent(CIBLE_TAG)).toEqual(CIBLE_TAG);
    expect(lireCibleOutilAgent({ ...CIBLE_TAG, intrus: true })).toBeNull();
    expect(lireCibleOutilAgent({ handler: 'poser_tag' })).toBeNull();
    expect(lireCibleOutilAgent({ handler: 'tag_fixe', tag: 'vip' })).toBeNull(); // le handler de l'agent de Meta
    expect(lireCibleOutilAgent({ ...CIBLE_BLOC, code: 'pas_un_code' })).toBeNull();
    expect(lireCibleOutilAgent({ ...CIBLE_SCENARIO, workflowId: 'pas-un-uuid' })).toBeNull();
    expect(lireCibleOutilAgent(cibleChamp(Array.from({ length: 51 }, (_, i) => `v${i}`)))).toBeNull();
  });

  it('un handler inventé n’existe pas', () => {
    expect(outilMaison('rm_rf')).toBeUndefined();
    expect(outilMaison('constructor')).toBeUndefined();
    expect(outilMaison('toString')).toBeUndefined();
  });
});

describe('paramsInitiaux', () => {
  it('🔴 n’écrit JAMAIS l’énumération qui se dérive de la fiche', () => {
    const p = paramsInitiaux(outilMaison('terminer')!);
    expect(p).toHaveLength(1);
    expect(p[0]!.name).toBe('sortie');
    expect(p[0]!.enum).toBeUndefined();
  });

  it('ne laisse pas fuir les champs de catalogue dans ce qui est stocké', () => {
    for (const modele of OUTILS_MAISON) {
      for (const p of paramsInitiaux(modele)) {
        expect(p, modele.handler).not.toHaveProperty('edition');
        expect(p, modele.handler).not.toHaveProperty('aideEnum');
        expect(p.source, modele.handler).toBe('modele');
      }
    }
  });
});

describe('outilsExposes', () => {
  it('🔴 l’énumération de « sortie » vient de la FICHE', () => {
    const [expose] = outilsExposes([outil(paramsInitiaux(outilMaison('terminer')!))], [
      { code: 'besoin_cerne', label: 'Besoin cerné' },
      { code: 'rdv_pris', label: 'Rendez-vous pris' },
    ]);
    expect(expose!.parameters.properties.sortie?.enum).toEqual(['besoin_cerne', 'rdv_pris']);
  });

  it('🔴 une énumération écrite en base est IGNORÉE au profit de la fiche', () => {
    // Le cas qui prouve la règle : si quelqu'un (une migration, une IA de construction, une main) écrit des
    // codes dans `params`, ils ne doivent pas atteindre le modèle. La fiche fait autorité, seule.
    const [expose] = outilsExposes(
      [outil([{ name: 'sortie', type: 'string', source: 'modele', required: true, enum: ['perime', 'faux'] }])],
      [{ code: 'besoin_cerne', label: 'Besoin cerné' }],
    );
    expect(expose!.parameters.properties.sortie?.enum).toEqual(['besoin_cerne']);
  });

  it('🔴 une fiche SANS règle d’arrêt RETIRE l’outil, elle ne l’offre pas sans énumération', () => {
    // Offert sans énumération, `terminer` accepterait n'importe quelle chaîne : le modèle en inventerait une,
    // le bloc n'aurait pas ce handle, et la conversation remonterait en inbox sans explication. Ne rien
    // offrir est plus honnête, et c'est déjà ce que l'écran des règles d'arrêt annonce.
    const t = outil(paramsInitiaux(outilMaison('terminer')!));
    expect(outilExpose(t, [])).toBeNull();
    expect(outilsExposes([t], [])).toEqual([]);
    // Et l'outil revient dès qu'une règle existe : le retrait suit la fiche, il ne s'installe pas.
    expect(outilsExposes([t], [{ code: 'fini', label: 'Fini' }])).toHaveLength(1);
  });

  it('🔴 la clause « quand NE PAS l’appeler » ATTEINT le modèle, annoncée', () => {
    // 🔴 ELLE NE L'ATTEIGNAIT PAS, jusqu'au 2026-08-29. La colonne existe depuis la migration 0086, la route
    // l'EXIGE pour un connecteur, l'écran l'affiche, l'IA de construction la rédige, et le CLAUDE.md dit
    // d'elle qu'« elle évite les appels de trop ». Mais `outilExpose` ne construisait que la description, et
    // la requête du runtime ne lisait même pas la colonne. Le client faisait un travail sans aucun effet, sur
    // le seul levier qui décide quand un outil se déclenche.
    const tag = outil([], 'poser_tag', CIBLE_TAG);
    const avecClause = { ...tag, description: 'Tague un contact intéressé.', nePasUtiliser: 'Jamais sur un contact déjà tagué.' };
    const [expose] = outilsExposes([avecClause], []);
    expect(expose!.description).toContain('Tague un contact intéressé.');
    expect(expose!.description).toContain('Jamais sur un contact déjà tagué.');
    // Annoncée, pas collée : deux paragraphes accolés se lisent comme une seule consigne, et une clause de
    // refus noyée dans une description d'usage est une clause qu'un modèle applique mal.
    expect(expose!.description).toContain('NE PAS');
    expect(expose!.description.indexOf('Tague un contact')).toBeLessThan(expose!.description.indexOf('Jamais sur'));
  });

  it('🔴 et la projection du RUNTIME lit bien la colonne, sinon la clause serait toujours vide', () => {
    // L'exposition ci-dessus ne prouve que la moitié : elle part d'un objet en mémoire. En production, la
    // clause vient de la base, et c'est précisément là qu'elle se perdait. `ne_pas_utiliser` ne vivait que
    // dans la projection d'ADMINISTRATION ; la requête d'exécution ne la sélectionnait pas, donc la clause
    // arrivait vide quoi qu'ait écrit le client, sans que rien ne le signale.
    //
    // Une lecture de la SOURCE plutôt qu'un test d'intégration : le `DATABASE_URL` local pointe sur la
    // production, et cette garde doit tourner partout, y compris ici.
    const sql = readFileSync(new URL('../src/agent/catalog.pg.ts', import.meta.url), 'utf8');
    const colonnes = /const COLONNES = `([^`]+)`/.exec(sql);
    expect(colonnes, 'la liste de colonnes du runtime a changé de forme dans src/agent/catalog.pg.ts').not.toBeNull();
    expect(colonnes![1]).toContain('ne_pas_utiliser');
  });

  it('une clause VIDE n’ajoute aucune rubrique : on ne paie pas du contexte pour ne rien dire', () => {
    const tag = outil([], 'poser_tag', CIBLE_TAG);
    const [expose] = outilsExposes([{ ...tag, description: 'Tague.', nePasUtiliser: '   ' }], []);
    expect(expose!.description).toBe('Tague.');
  });

  it('une liste vide REMPLIE PAR LE CLIENT ne retire rien : vide y veut dire « aucune restriction »', () => {
    // RC4 : les valeurs permises d'un champ fixé. Vide, toute valeur passe, et l'outil reste offert.
    const champ = outil(paramsInitiaux(outilMaison('ecrire_variable')!), 'ecrire_variable', cibleChamp([]));
    const [expose] = outilsExposes([champ], []);
    expect(expose!.name).toBe('mba_terminer');
    expect(expose!.parameters.properties.valeur?.enum).toBeUndefined();
  });

  it('🔴 RC4 : les valeurs permises d’un champ fixé sont ANNONCÉES au modèle ET APPLIQUÉES par la validation', () => {
    // Dérivées de la cible, jamais recopiées dans `params` : la même lecture (`paramsEffectifs`) sert l'exposition et
    // `executeTool`. Une borne appliquée sans être annoncée ferait refuser un modèle coopératif.
    const champ = outil(paramsInitiaux(outilMaison('ecrire_variable')!), 'ecrire_variable', cibleChamp(['client', 'prospect']));
    expect(paramsEffectifs(champ).find((p) => p.name === 'valeur')?.enum).toEqual(['client', 'prospect']);
    const [expose] = outilsExposes([champ], []);
    expect(expose!.parameters.properties.valeur?.enum).toEqual(['client', 'prospect']);
    // Les paramètres stockés n'en portent rien.
    expect(paramsInitiaux(outilMaison('ecrire_variable')!)[0]).not.toHaveProperty('enum');
  });

  it('🔴 RC4 : un outil à cible SANS cible lisible est RETIRÉ, pas offert (il refuserait chaque appel)', () => {
    for (const h of ['poser_tag', 'ecrire_variable', 'envoyer_bloc', 'lancer_scenario']) {
      expect(outilExpose(outil(paramsInitiaux(outilMaison(h)!), h), []), h).toBeNull();
    }
    // Une cible d'un autre handler ne vaut pas.
    expect(outilExpose(outil([], 'poser_tag', { ...CIBLE_SCENARIO, handler: 'poser_tag' }), [])).toBeNull();
    // Et chacun revient avec sa cible.
    expect(outilsExposes([
      outil([], 'poser_tag', CIBLE_TAG), outil(paramsInitiaux(outilMaison('ecrire_variable')!), 'ecrire_variable', cibleChamp([])),
      outil([], 'envoyer_bloc', CIBLE_BLOC), outil([], 'lancer_scenario', CIBLE_SCENARIO),
    ], [])).toHaveLength(4);
  });

  it('les autres outils ne sont pas touchés par la dérivation', () => {
    const tag = outil([{ name: 'tag', type: 'string', source: 'modele', required: true, enum: ['vip'] }], 'poser_tag', CIBLE_TAG);
    const [expose] = outilsExposes([tag], [{ code: 'besoin_cerne', label: 'B' }]);
    expect(expose!.parameters.properties.tag?.enum).toEqual(['vip']);
  });

  it('un outil dont le handler n’est plus au catalogue expose ses params tels quels', () => {
    // Cas d'une ligne écrite par une version antérieure : elle ne doit pas faire tomber la construction du
    // schéma, sinon le tour entier échoue à cause d'une seule ligne périmée.
    const orphelin = outil([{ name: 'x', type: 'string', source: 'modele' }], 'disparu');
    const [expose] = outilsExposes([orphelin], []);
    expect(expose!.parameters.properties.x).toEqual({ type: 'string' });
  });

  it('🔴 un paramètre non rempli par le modèle reste invisible, dérivation ou pas', () => {
    // La garde de la tâche 15 tient toujours après passage par la dérivation : `contact` et `fixe` ne sont
    // jamais exposés, sans quoi un connecteur deviendrait un IDOR.
    const avecContact = outil([
      { name: 'sortie', type: 'string', source: 'modele', required: true },
      { name: 'wa_id', type: 'string', source: 'contact', contactPath: 'wa_id' },
    ]);
    const [expose] = outilsExposes([avecContact], [{ code: 'fini', label: 'Fini' }]);
    // `message` est imposé par le catalogue et rempli par le modèle : il est là, `wa_id` non.
    expect(Object.keys(expose!.parameters.properties)).toEqual(['sortie', 'message']);
  });
});

/**
 * 🔴 LE DERNIER MESSAGE PORTÉ PAR `terminer`. Sous certains modèles, l'agent appelle l'outil sans rien écrire
 * à côté : le tour s'arrête sur l'appel et le contact ne reçoit rien. Le paramètre `message` est IMPOSÉ par le
 * catalogue, jamais stocké : les outils déjà posés gardent en base la copie de leurs paramètres (sans lui), et
 * c'est elle que lisent à la fois l'exposition et la validation. Les deux doivent le voir.
 */
describe('terminer : le paramètre imposé « message »', () => {
  const SORTIES = [{ code: 'fini', label: 'Fini' }];

  it('🔴 il est EXPOSÉ requis à côté de « sortie », pour un outil dont la copie en base ne le déclare pas', () => {
    // La copie telle qu'un outil posé avant ce lot la porte : `sortie` seule.
    const pose = outil([{ name: 'sortie', type: 'string', source: 'modele', required: true }]);
    const [expose] = outilsExposes([pose], SORTIES);
    expect(Object.keys(expose!.parameters.properties)).toEqual(['sortie', 'message']);
    expect(expose!.parameters.required).toEqual(['sortie', 'message']);
    expect(expose!.parameters.properties.message).toEqual({
      type: 'string',
      description: 'Ton dernier message au contact avant de rendre la main : récapitulatif, confirmation ou au revoir, dans le ton de la conversation. Toujours rempli.',
    });
  });

  it('🔴 la validation le voit aussi, mais NON requis : annoncé requis, toléré absent', () => {
    const effectifs = paramsEffectifs(outil(paramsInitiaux(outilMaison('terminer')!)));
    expect(effectifs.map((p) => p.name)).toEqual(['sortie', 'message']);
    expect(effectifs.find((p) => p.name === 'message')!.required).toBeUndefined();
  });

  it('une copie qui le déclare déjà garde SA déclaration, sans doublon', () => {
    const effectifs = paramsEffectifs(outil([
      { name: 'sortie', type: 'string', source: 'modele', required: true },
      { name: 'message', type: 'string', source: 'modele', description: 'à moi' },
    ]));
    expect(effectifs.filter((p) => p.name === 'message')).toEqual([{ name: 'message', type: 'string', source: 'modele', description: 'à moi' }]);
  });

  it('🔴 il n’est JAMAIS écrit en base, ni montré au catalogue que la console édite', () => {
    // `paramsInitiaux` est ce que la pose d'un outil écrit : le stocker recréerait la copie qui diverge.
    expect(paramsInitiaux(outilMaison('terminer')!).map((p) => p.name)).toEqual(['sortie']);
    expect(outilMaison('terminer')!.params.map((p) => p.name)).toEqual(['sortie']);
  });

  it('🔴 « escalader » le reçoit aussi : exposé requis, toléré absent, jamais stocké (mesuré le 2026-10-05)', () => {
    // Le même défaut que `terminer` : Mistral Small, Claude Sonnet 4.5 et Gemini 2.5 Flash Lite passent la main sans un mot.
    const pose = outil([], 'escalader');
    const [expose] = outilsExposes([pose], []);
    expect(expose!.parameters.required).toEqual(['message']);
    expect(expose!.parameters.properties.message).toMatchObject({ type: 'string' });
    expect(paramsEffectifs(pose).find((p) => p.name === 'message')!.required).toBeUndefined();
    expect(paramsInitiaux(outilMaison('escalader')!)).toEqual([]);
  });

  it('un outil qui n’est pas maison n’en reçoit aucun, même avec un `handler` « terminer » dans sa liaison', () => {
    const mcp = { ...outil([{ name: 'q', type: 'string', source: 'modele' }]), origin: 'mcp' as const };
    expect(paramsEffectifs(mcp).map((p) => p.name)).toEqual(['q']);
    // Ni à l'exposition : un `message` déclaré par l'outil MCP lui-même n'y devient pas obligatoire.
    const [exposeMcp] = outilsExposes([{ ...mcp, params: [{ name: 'message', type: 'string', source: 'modele' }] }], SORTIES);
    expect(exposeMcp!.parameters.required ?? []).not.toContain('message');
    // Et les autres outils maison n'en ont pas.
    const tag = outil([{ name: 'tag', type: 'string', source: 'modele', required: true }], 'poser_tag');
    expect(paramsEffectifs(tag).map((p) => p.name)).toEqual(['tag']);
  });
});
