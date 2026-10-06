import { describe, it, expect, vi } from 'vitest';
import { creerResolveurMba, type DepsResolveurMba } from '../src/agent/resolvers/mba';
import type { ContexteAppel } from '../src/agent/executor';
import type { OutilDefini } from '../src/agent/catalog';
import { SANS_MCP } from './outils-mcp';
import { AUCUN_GESTE } from './gestes';

/**
 * Tâche 16 : les outils maison. Ce sont les seuls outils dont nous écrivons le comportement, donc les seuls
 * sur lesquels on peut promettre quelque chose.
 */

const CTX: ContexteAppel = {
  tenantId: 't1', agentId: 'ag1', sessionId: 's1', runId: 'r1', workflowId: 'wf1', waId: '33600',
  contact: { wa_id: '33600', prenom: 'Julien' },
  contactInconnu: 'tous', appelsRestants: 5, budgetRestantMicroEur: 10_000, deadline: Date.now() + 30_000,
};

const outil = (handler: string, binding: Record<string, unknown> = { handler }): OutilDefini => ({ ...SANS_MCP, ...AUCUN_GESTE(),
  id: 'to1', tenantId: 't1', origin: 'mba', name: `mba_${handler}`, description: '',
  params: [], binding, sourceId: null, requestId: null, nePasUtiliser: '', nature: 'integre' as const, outputPaths: [], risk: 'write', timeoutMs: 5_000, maxBytes: 16_384, autonome: false,
});

/** Les cibles fixées par l'administrateur (RC4), telles que la pose les écrit dans `binding`. */
const WF_CIBLE = '0b7e2c1a-4d5e-4f60-8a9b-1c2d3e4f5a6b';
const CIBLES = {
  tag: { handler: 'poser_tag', tag: 'rdv_pris' },
  champ: { handler: 'ecrire_variable', champ: 'statut', valeurs: [] as string[] },
  champBorne: { handler: 'ecrire_variable', champ: 'statut', valeurs: ['client', 'prospect'] },
  bloc: { handler: 'envoyer_bloc', workflowId: WF_CIBLE, code: 'nod_t1_01HZX5Y6Z7A8B9C0D1E2F3G4H5' },
  scenario: { handler: 'lancer_scenario', workflowId: WF_CIBLE },
} as const;

function harnais(over: Partial<DepsResolveurMba> = {}) {
  const journal: string[] = [];
  const deps: DepsResolveurMba = {
    envoyerBloc: async (i) => { journal.push(`bloc:${i.workflowId}:${i.code}`); return { ok: true }; },
    lancerScenario: async (i) => { journal.push(`scenario:${i.workflowId}:${i.runId}:${i.sessionId}`); return { ok: true }; },
    escaladerVersHumain: async (i) => { journal.push(`escalade:${i.waId}:${i.sessionId}:${i.agentId}`); return true; },
    marquerUrgente: async (i) => { journal.push(`urgent:${i.tenantId}:${i.waId}:${i.agentId}`); return true; },
    poserTag: async (_t, _w, tag) => { journal.push(`tag:${tag}`); },
    ecrireChamp: async (_t, _w, cle, valeur) => { journal.push(`champ:${cle}=${valeur}`); },
    lireAnalyse: async (t, w) => { journal.push(`analyse:${t}:${w}`); return null; },
    // La recherche a sa propre suite (`tests/agent-knowledge.test.ts`) : ici elle ne rend rien.
    connaissance: { chercher: async () => [] },
    ...over,
  };
  return { resolveur: creerResolveurMba(deps), journal };
}

const appel = (handler: string, args: Record<string, unknown> = {}, ctx: ContexteAppel = CTX) =>
  ({ outil: outil(handler), args, ctx, signal: new AbortController().signal });

/** Un appel d'outil à cible : le `binding` porte la cible fixée, les arguments sont ceux du modèle. */
const appelCible = (cible: { handler: string }, args: Record<string, unknown> = {}, ctx: ContexteAppel = CTX) =>
  ({ outil: outil(cible.handler, { ...cible }), args, ctx, signal: new AbortController().signal });

describe('résolveur maison (tâche 16)', () => {
  it('« terminer » remonte la sortie, que le tour transformera en handle sortie:<code>', async () => {
    const { resolveur } = harnais();
    const r = await resolveur(appel('terminer', { sortie: 'besoin_cerne' }));
    expect(r.sortie).toBe('besoin_cerne');
    expect(r.ok).not.toBe(false);
  });

  it('🔴 « terminer » rend le dernier message ROGNÉ, et rien pour un message absent, vide ou blanc', async () => {
    // Le cerveau l'envoie au contact quand le modèle a appelé l'outil sans rien écrire à côté. Une chaîne
    // vide rendue ici ferait croire qu'il y a quelque chose à envoyer.
    const { resolveur } = harnais();
    const r = await resolveur(appel('terminer', { sortie: 'fini', message: '  Merci, à bientôt.\n' }));
    expect(r).toEqual({ contenu: { sortie: 'fini' }, sortie: 'fini', dernierMessage: 'Merci, à bientôt.' });
    for (const vide of [{}, { message: '' }, { message: '  \n ' }]) {
      const sans = await resolveur(appel('terminer', { sortie: 'fini', ...vide }));
      expect(sans, JSON.stringify(vide)).toEqual({ contenu: { sortie: 'fini' }, sortie: 'fini' });
      expect(sans, JSON.stringify(vide)).not.toHaveProperty('dernierMessage');
    }
  });

  it('🔴 « marquer_urgent » marque la conversation du contact du TOUR, et d’aucun autre', async () => {
    // L'outil n'a aucun paramètre : un numéro glissé dans les arguments (injection réussie) n'atteint pas l'écriture.
    const { resolveur, journal } = harnais();
    const r = await resolveur(appel('marquer_urgent', { wa_id: '33699999999', conversation_id: 'une-autre' }));
    expect(r.ok).not.toBe(false);
    expect(r.contenu).toEqual({ urgente: true });
    expect(journal).toEqual(['urgent:t1:33600:ag1']);
  });

  it('🔴 « marquer_urgent » ne termine rien : ni sortie, ni main rendue, l’agent continue de répondre', async () => {
    // Urgent n'est pas un transfert (décision de Julien du 2026-10-06) : `rendu` arrêterait le tour, `sortie` ferait
    // quitter le bloc. La preuve de bout en bout : `tests/agent-run-turn.test.ts`.
    const { resolveur } = harnais();
    const r = await resolveur(appel('marquer_urgent'));
    expect(r).not.toHaveProperty('rendu');
    expect(r).not.toHaveProperty('sortie');
    expect(r).not.toHaveProperty('mainPrise');
  });

  it('« marquer_urgent » sans conversation pour ce contact : un échec dit au modèle, jamais levé', async () => {
    const { resolveur } = harnais({ marquerUrgente: async () => false });
    const r = await resolveur(appel('marquer_urgent'));
    expect(r.ok).toBe(false);
  });

  it('🔴 RC4 : chaque handler à cible agit sur SA cible, quels que soient les arguments du modèle', async () => {
    // Le modèle glisse une autre cible dans ses arguments (injection réussie, ou simple invention) : le tag, le champ,
    // le bloc et le scénario restent ceux que l'administrateur a fixés.
    const { resolveur, journal } = harnais();
    expect((await resolveur(appelCible(CIBLES.tag, { tag: 'autre' }))).ok).not.toBe(false);
    expect((await resolveur(appelCible(CIBLES.champ, { cle: 'opt_in', champ: 'opt_in', valeur: 'client' }))).ok).not.toBe(false);
    expect((await resolveur(appelCible(CIBLES.bloc, { code: 'nod_t1_AUTRE', workflowId: 'wf-autre' }))).ok).not.toBe(false);
    const lance = await resolveur(appelCible(CIBLES.scenario, { workflowId: 'wf-autre' }));
    expect(lance.ok).not.toBe(false);
    expect(journal).toEqual([
      'tag:rdv_pris',
      'champ:statut=client',
      `bloc:${WF_CIBLE}:nod_t1_01HZX5Y6Z7A8B9C0D1E2F3G4H5`,
      `scenario:${WF_CIBLE}:r1:s1`,
    ]);
  });

  it('🔴 RC4 : le modèle ne lit jamais le nom du tag ni du champ (des noms internes qu’il répéterait au contact)', async () => {
    const { resolveur } = harnais();
    expect((await resolveur(appelCible(CIBLES.tag))).contenu).toEqual({ pose: true });
    expect((await resolveur(appelCible(CIBLES.champ, { valeur: 'client' }))).contenu).toEqual({ ecrit: true });
  });

  it('🔴 RC4 : une cible illisible, absente ou d’un autre handler REFUSE l’appel, sans rien faire', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { resolveur, journal } = harnais();
    // Un outil posé avant RC4 : `binding` ne porte que le handler.
    for (const h of ['poser_tag', 'ecrire_variable', 'envoyer_bloc', 'lancer_scenario']) {
      const r = await resolveur(appel(h, { tag: 'vip', cle: 'statut', valeur: 'x', code: 'nod_t1_X' }));
      expect(r.ok, h).toBe(false);
      expect(r.contenu, h).toEqual({ erreur: expect.stringContaining('outil mal configuré') });
    }
    // Une cible d'un autre handler sous ce handler (binding réécrit à la main), et une clé en trop.
    expect((await resolveur({ ...appel('poser_tag'), outil: outil('poser_tag', { ...CIBLES.scenario, handler: 'poser_tag' }) })).ok).toBe(false);
    expect((await resolveur({ ...appel('poser_tag'), outil: outil('poser_tag', { ...CIBLES.tag, intrus: 1 }) })).ok).toBe(false);
    expect(journal).toEqual([]);
  });

  it('« ecrire_variable » : une valeur hors de la liste permise est refusée, une valeur vide aussi', async () => {
    const { resolveur, journal } = harnais();
    expect((await resolveur(appelCible(CIBLES.champBorne, { valeur: 'inventee' }))).ok).toBe(false);
    expect((await resolveur(appelCible(CIBLES.champ, { valeur: '  ' }))).ok).toBe(false);
    expect((await resolveur(appelCible(CIBLES.champBorne, { valeur: 'prospect' }))).ok).not.toBe(false);
    expect(journal).toEqual(['champ:statut=prospect']);
  });

  it('« lire_contact » rend la fiche DEJA lue par le tour, sans jamais accepter d identifiant du modele', async () => {
    // Le modèle ne fournit aucun identifiant ici : il n'existe donc aucun chemin pour lire la fiche de
    // quelqu'un d'autre, même en cas d'injection réussie dans le message du contact.
    const { resolveur, journal } = harnais();
    const r = await resolveur(appel('lire_contact', { wa_id: '33699999999' }));
    expect(r.contenu).toEqual({ connu: true, champs: { wa_id: '33600', prenom: 'Julien' }, derniere_analyse: null, resume: null });
    // L'analyse se lit pour le contact du TOUR, jamais pour le numéro que le modèle a glissé dans ses arguments.
    expect(journal).toEqual(['analyse:t1:33600']);

    const inconnu = await resolveur(appel('lire_contact', {}, { ...CTX, contact: null }));
    expect(inconnu.contenu).toEqual({ connu: false });
    expect(journal).toEqual(['analyse:t1:33600']); // contact inconnu : aucune lecture de plus
  });

  it('🔴 « lire_contact » rend la dernière analyse et son résumé ; une note à 0 reste 0, `false` reste `false`', async () => {
    const { resolveur } = harnais({
      lireAnalyse: async () => ({
        analyse: {
          intention: 'reclamation', sentiment: 'negatif', satisfaction: 0, urgence: null, resolue: false, sujet: 'colis perdu',
          traiteePar: 'humain', action: 'rappeler', analyseLe: new Date('2026-09-26T14:32:00.000Z'),
          fenetreFin: new Date('2026-09-26T14:30:00.000Z'), conversationId: 'c1',
        },
        resume: 'Le client attend son colis depuis dix jours.',
      }),
    });
    const r = await resolveur(appel('lire_contact'));
    expect(r.contenu).toEqual({
      connu: true, champs: { wa_id: '33600', prenom: 'Julien' },
      derniere_analyse: {
        intention: 'reclamation', sentiment: 'negatif', satisfaction: 0, urgence: null, resolue: false, sujet: 'colis perdu',
        traitee_par: 'humain', action_suggeree: 'rappeler', analysee_le: '2026-09-26T14:32:00.000Z',
      },
      resume: 'Le client attend son colis depuis dix jours.',
    });
  });

  it('⚠️ « lire_contact » : une lecture d’analyse ratée rend la fiche et le dit, sans prétendre « jamais analysé »', async () => {
    const { resolveur } = harnais({ lireAnalyse: async () => { throw new Error('connexion perdue'); } });
    const r = await resolveur(appel('lire_contact'));
    expect(r.contenu).toEqual({ connu: true, champs: { wa_id: '33600', prenom: 'Julien' }, analyse_indisponible: true });
  });

  it('🔴 « escalader » appelle la dep d escalade et rend « rendu » : le tour doit s arreter', async () => {
    // `rendu` est ce qui empêche l'agent d'écrire un message de plus alors que la main n'est plus à lui.
    const { resolveur, journal } = harnais();
    const r = await resolveur(appel('escalader'));
    expect(journal).toEqual([`escalade:33600:s1:ag1`]);
    expect(r.rendu).toBe(true);
    expect(r.sortie).toBeUndefined(); // la dep a DÉJÀ tout fait : une seconde sortie doublerait la reprise
    // La bascule a EU LIEU, donc c'est nous qui tenons la main : le tour a le droit d'écrire sa dernière
    // phrase, celle qui dit au contact que l'équipe est fermée (revue du 2026-09-18).
    expect(r.mainPrise).toBe(true);
  });

  it('🔴 « escalader » rend le `message` imposé, ROGNÉ, en dernier message ; rien pour un message absent, vide ou blanc', async () => {
    // Même contrat que « terminer » : le cerveau l'envoie quand le modèle n'a rien écrit à côté de l'appel.
    const { resolveur } = harnais();
    expect(await resolveur(appel('escalader', { message: '  Un conseiller prend le relais.\n' }))).toMatchObject({
      rendu: true, mainPrise: true, dernierMessage: 'Un conseiller prend le relais.',
    });
    for (const vide of [{}, { message: '' }, { message: '  \n ' }]) {
      expect(await resolveur(appel('escalader', vide)), JSON.stringify(vide)).not.toHaveProperty('dernierMessage');
    }
  });

  it('🔴 « escalader » quand un OPÉRATEUR avait déjà la main : `mainPrise` est faux', async () => {
    // La preuve inverse, et elle est le contrat entier de ce booléen. `setControlOwner` rend `false` quand le
    // fil n'était pas `app_workflow` : le tour doit alors se taire, exactement comme avant, plutôt que
    // d'écrire par-dessus la conversation qu'un humain vient de reprendre.
    const { resolveur } = harnais({ escaladerVersHumain: async () => false });
    const r = await resolveur(appel('escalader'));
    expect(r.rendu).toBe(true);
    expect(r.mainPrise).toBe(false);
  });

  it('« envoyer_bloc » rend le refus du parcours au modele', async () => {
    const ko = harnais({ envoyerBloc: async () => ({ ok: false, raison: 'ce bloc attend une réponse du client' }) });
    const r = await ko.resolveur(appelCible(CIBLES.bloc));
    expect(r.ok).toBe(false);
    expect(r.contenu).toEqual({ erreur: 'ce bloc attend une réponse du client' });
  });

  it('🔴 « lancer_scenario » réussi est TERMINAL : `scenarioLance`, ni sortie ni main rendue', async () => {
    const { resolveur } = harnais();
    const r = await resolveur(appelCible(CIBLES.scenario));
    expect(r).toEqual({ contenu: { lance: true }, scenarioLance: true });
  });

  it('🔴 « lancer_scenario » refusé (dépublié, supprimé, désabonné) : la raison au modèle, et RIEN de terminal', async () => {
    const { resolveur } = harnais({ lancerScenario: async () => ({ ok: false, raison: 'le scénario est vide' }) });
    const r = await resolveur(appelCible(CIBLES.scenario));
    expect(r.ok).toBe(false);
    expect(r.contenu).toEqual({ erreur: 'le scénario est vide' });
    expect(r).not.toHaveProperty('scenarioLance');
  });

  it('🔴 « lancer_scenario » refuse de relancer le scénario où l’agent parle, sans rien lancer', async () => {
    // Le scénario retomberait sur l'agent, qui pourrait le relancer encore : une boucle facturée sans message du contact.
    const { resolveur, journal } = harnais();
    const r = await resolveur(appelCible(CIBLES.scenario, {}, { ...CTX, workflowId: WF_CIBLE }));
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty('scenarioLance');
    expect(journal).toEqual([]);
  });

  it('un handler inconnu ou absent est refuse proprement, jamais une exception', async () => {
    const { resolveur } = harnais();
    expect((await resolveur(appel('handler_qui_n_existe_pas'))).ok).toBe(false);
    const sansHandler = { ...appel('terminer'), outil: { ...outil('terminer'), binding: {} } };
    expect((await resolveur(sansHandler)).ok).toBe(false);
  });

  it('un handler nommé comme une méthode du prototype est refuse, pas appele', async () => {
    // `binding` est du jsonb écrit par la console : un accès direct à la table retrouverait
    // `Object.prototype.valueOf`, appelé sans `this` donc en exception, là où on veut un refus propre.
    const { resolveur } = harnais();
    for (const nom of ['valueOf', 'toString', 'constructor', 'hasOwnProperty']) {
      const r = await resolveur(appel(nom));
      expect(r.ok).toBe(false);
      expect(r.contenu).toMatchObject({ erreur: expect.stringContaining('inconnu') });
    }
  });

  it('le comportement suit le HANDLER, pas le nom expose au modele', async () => {
    // Le client peut renommer un outil dans sa console (un nom parlant fait un meilleur agent) : le
    // comportement ne doit pas suivre le nom.
    const { resolveur, journal } = harnais();
    const renomme = { ...appelCible(CIBLES.tag), outil: { ...outil('poser_tag', { ...CIBLES.tag }), name: 'marquer_le_client' } };
    await resolveur(renomme);
    expect(journal).toEqual(['tag:rdv_pris']);
  });

});
