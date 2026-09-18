import { describe, it, expect } from 'vitest';
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

const outil = (handler: string): OutilDefini => ({ ...SANS_MCP, ...AUCUN_GESTE(),
  id: 'to1', tenantId: 't1', origin: 'mba', name: `mba_${handler}`, description: '',
  params: [], binding: { handler }, sourceId: null, requestId: null, nePasUtiliser: '', nature: 'integre' as const, outputPaths: [], risk: 'write', timeoutMs: 5_000, maxBytes: 16_384, autonome: false,
});

function harnais(over: Partial<DepsResolveurMba> = {}) {
  const journal: string[] = [];
  const deps: DepsResolveurMba = {
    envoyerBloc: async (i) => { journal.push(`bloc:${i.code}`); return { ok: true }; },
    escaladerVersHumain: async (i) => { journal.push(`escalade:${i.waId}:${i.sessionId}`); },
    poserTag: async (_t, _w, tag) => { journal.push(`tag:${tag}`); },
    ecrireChamp: async (_t, _w, cle, valeur) => { journal.push(`champ:${cle}=${valeur}`); },
    // La recherche a sa propre suite (`tests/agent-knowledge.test.ts`) : ici elle ne rend rien.
    connaissance: { chercher: async () => [] },
    ...over,
  };
  return { resolveur: creerResolveurMba(deps), journal };
}

const appel = (handler: string, args: Record<string, unknown> = {}, ctx: ContexteAppel = CTX) =>
  ({ outil: outil(handler), args, ctx, signal: new AbortController().signal });

describe('résolveur maison (tâche 16)', () => {
  it('« terminer » remonte la sortie, que le tour transformera en handle sortie:<code>', async () => {
    const { resolveur } = harnais();
    const r = await resolveur(appel('terminer', { sortie: 'besoin_cerne' }));
    expect(r.sortie).toBe('besoin_cerne');
    expect(r.ok).not.toBe(false);
  });

  it('« poser_tag » et « ecrire_variable » agissent, et refusent proprement un parametre manquant', async () => {
    const { resolveur, journal } = harnais();
    await resolveur(appel('poser_tag', { tag: 'vip' }));
    await resolveur(appel('ecrire_variable', { cle: 'statut', valeur: 'client' }));
    expect(journal).toEqual(['tag:vip', 'champ:statut=client']);

    // Les arguments sont déjà validés par le tronc commun, mais contre une DÉCLARATION qui vient du client :
    // un handler ne suppose jamais que sa déclaration est bien faite.
    const sansTag = await resolveur(appel('poser_tag', {}));
    expect(sansTag.ok).toBe(false);
    expect(journal).toEqual(['tag:vip', 'champ:statut=client']); // rien de plus n'a été fait
  });

  it('« lire_contact » rend la fiche DEJA lue par le tour, sans jamais accepter d identifiant du modele', async () => {
    // Le modèle ne fournit aucun identifiant ici : il n'existe donc aucun chemin pour lire la fiche de
    // quelqu'un d'autre, même en cas d'injection réussie dans le message du contact.
    const { resolveur } = harnais();
    const r = await resolveur(appel('lire_contact', { wa_id: '33699999999' }));
    expect(r.contenu).toEqual({ connu: true, champs: { wa_id: '33600', prenom: 'Julien' } });

    const inconnu = await resolveur(appel('lire_contact', {}, { ...CTX, contact: null }));
    expect(inconnu.contenu).toEqual({ connu: false });
  });

  it('🔴 « escalader » appelle la dep d escalade et rend « rendu » : le tour doit s arreter', async () => {
    // `rendu` est ce qui empêche l'agent d'écrire un message de plus alors que la main n'est plus à lui.
    const { resolveur, journal } = harnais();
    const r = await resolveur(appel('escalader'));
    expect(journal).toEqual(['escalade:33600:s1']);
    expect(r.rendu).toBe(true);
    expect(r.sortie).toBeUndefined(); // la dep a DÉJÀ tout fait : une seconde sortie doublerait la reprise
  });

  it('« envoyer_bloc » passe le code, et rend le refus du parcours au modele', async () => {
    const ok = harnais();
    expect((await ok.resolveur(appel('envoyer_bloc', { code: 'nod_x_1' }))).ok).not.toBe(false);
    expect(ok.journal).toEqual(['bloc:nod_x_1']);

    const ko = harnais({ envoyerBloc: async () => ({ ok: false, raison: 'code de bloc inconnu' }) });
    const r = await ko.resolveur(appel('envoyer_bloc', { code: 'inventé' }));
    expect(r.ok).toBe(false);
    expect(r.contenu).toEqual({ erreur: 'code de bloc inconnu' });
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
    const renomme = { ...appel('poser_tag', { tag: 'vip' }), outil: { ...outil('poser_tag'), name: 'marquer_le_client' } };
    await resolveur(renomme);
    expect(journal).toEqual(['tag:vip']);
  });

});
