import { describe, it, expect, vi } from 'vitest';
import { creerResolveurMcp } from '../src/agent/resolvers/mcp';
import type { EntreeResolveur } from '../src/agent/executor';
import type { OutilDefini } from '../src/agent/catalog';
import type { SourceAppel } from '../src/agent/sources';
import { SANS_MCP } from './outils-mcp';

/**
 * LE RÉSOLVEUR MCP : ce qui se passe quand un agent appelle un outil importé d'un serveur tiers.
 *
 * 🔴 SANS LUI, UN OUTIL `origin='mcp'` ARRÊTE LE TOUR. L'exécuteur dispatche sur
 * `deps.resolveurs[outil.origin]` et, faute de résolveur, rend `erreur_protocole` avec `fatal: true`. Le
 * câbler dans le même lot que l'import n'est donc pas une commodité de rangement.
 *
 * 🔴 IL NE PASSE PAS PAR `creerAppelConnecteur`, et c'est délibéré. Ce point de passage-là construit une
 * cible HTTP depuis une ligne de `connector_requests` ; un outil MCP n'en a pas, ses paramètres viennent du
 * schéma distant. Les forcer dans le même moule ferait deux moitiés de fonction qui ne s'appliquent chacune
 * qu'à la moitié des appels, ce qui est la façon dont on finit par sauter une garde.
 */

const SOURCE: SourceAppel = {
  id: 'src1', baseUrl: 'https://exemple.test/mcp',
  authKind: 'bearer', authHeaderName: null, authSecret: 'jeton-secret', status: 'active',
};

const OUTIL = (over: Partial<OutilDefini> = {}): OutilDefini => ({
  ...SANS_MCP,
  id: 'to1', tenantId: 't1', origin: 'mcp', sourceId: 'src1', requestId: null, nePasUtiliser: '',
  name: 'notion_search', description: 'cherche', binding: { outilDistant: 'search' },
  params: [], nature: 'integre', outputPaths: [],
  risk: 'read', timeoutMs: 5_000, maxBytes: 16_384, autonome: false,
  ...over,
});

const CTX = {
  tenantId: 't1', agentId: 'ag1', sessionId: 's1', runId: 'r1', workflowId: 'wf1', waId: '33600',
  contact: { nom: 'Ada', tags: [], champs: { email: 'ada@exemple.test' } },
  contactInconnu: 'tous' as const, appelsRestants: 5, budgetRestantMicroEur: 10_000,
  deadline: Date.now() + 30_000,
};

function harnais(over: {
  session?: Partial<{ lister: unknown; appeler: unknown; fermer: unknown }>;
  source?: SourceAppel | null;
  resolution?: { ok: boolean };
} = {}) {
  const appeler = vi.fn(async () => ({ texte: 'reponse du serveur', estErreur: false }));
  const fermer = vi.fn(async () => {});
  const session = { lister: vi.fn(), appeler, fermer, ...over.session };
  const ouvrirSession = vi.fn(async () => session);
  const epreuves: Array<{ ok: boolean }> = [];
  const resolveur = creerResolveurMcp({
    sources: {
      pourAppel: async () => (over.source === undefined ? SOURCE : over.source),
      marquerEpreuve: async (_t, _i, ok) => { epreuves.push({ ok }); },
    },
    ouvrirSession: ouvrirSession as never,
    verifierResolution: async () => over.resolution ?? { ok: true },
  });
  return { resolveur, appeler, fermer, ouvrirSession, epreuves };
}

const entree = (outil: OutilDefini, args: Record<string, unknown> = {}): EntreeResolveur => ({
  outil, args, ctx: CTX, signal: AbortSignal.timeout(10_000),
});

describe('le resolveur MCP : ce qui PART chez le serveur', () => {
  it('🔴 RECOMPOSE l objet imbrique depuis les chemins avant d appeler', async () => {
    // 🔴 Notre nom est une etiquette LOCALE, plate et normalisee. Le serveur distant attend SA forme.
    // Sans recomposition, l appel partirait avec `filtres_ville` a la racine, une cle qu il ne connait pas.
    const h = harnais();
    await h.resolveur(entree(
      OUTIL({ params: [{ name: 'filtres_ville', type: 'string', source: 'modele', cheminMcp: 'filtres.ville' }] }),
      { filtres_ville: 'Lyon' },
    ));
    expect(h.appeler).toHaveBeenCalledWith('search', { filtres: { ville: 'Lyon' } });
  });

  it('envoie le nom DISTANT, pas le notre', async () => {
    const h = harnais();
    await h.resolveur(entree(OUTIL({ name: 'notion_search', binding: { outilDistant: 'search' } })));
    expect((h.appeler.mock.calls[0]! as unknown as [string])[0]).toBe('search');
  });

  it('⚠️ une valeur INJECTEE a null part quand meme : le serveur decide', async () => {
    // Decision de Julien du 2026-09-16. Refuser serait faux pour un parametre facultatif.
    const h = harnais();
    await h.resolveur(entree(
      OUTIL({ params: [{ name: 'email_client', type: 'string', source: 'champ', cle: 'inconnu', cheminMcp: 'client.email' }] }),
      { email_client: null },
    ));
    expect(h.appeler).toHaveBeenCalledWith('search', { client: { email: null } });
  });

  it('un parametre ABSENT des arguments n est pas invente', async () => {
    const h = harnais();
    await h.resolveur(entree(
      OUTIL({ params: [{ name: 'ville', type: 'string', source: 'modele', cheminMcp: 'filtres.ville' }] }),
      {},
    ));
    expect(h.appeler).toHaveBeenCalledWith('search', {});
  });

  it('🔴 le jeton de la source part en en-tete, et JAMAIS dans ce qui revient au modele', async () => {
    const h = harnais({ session: { appeler: vi.fn(async () => ({ echec: { genre: 'refus', code: 401, message: 'Unauthorized' } })) } });
    const r = await h.resolveur(entree(OUTIL()));
    expect((h.ouvrirSession.mock.calls[0]! as unknown as [{ enTetes: Record<string, string> }])[0].enTetes.authorization).toBe('Bearer jeton-secret');
    expect(JSON.stringify(r)).not.toContain('jeton-secret');
  });
});

describe('le resolveur MCP : les gardes, AVANT tout appel', () => {
  it('🔴 une adresse qui resout vers une adresse privee est refusee SANS ouvrir de session', async () => {
    // 🔴 L ORDRE EST LA GARDE. Une verification posee apres l ouverture serait decorative : la connexion
    // aurait deja eu lieu, donc le degat aussi.
    const h = harnais({ resolution: { ok: false } });
    const r = await h.resolveur(entree(OUTIL()));
    expect(r.ok).toBe(false);
    expect(h.ouvrirSession).not.toHaveBeenCalled();
  });

  it('une source DESACTIVEE n est plus appelee, sans attendre un redemarrage', async () => {
    // La source est relue a CHAQUE appel, comme dans le resolveur HTTP : la figer laisserait un connecteur
    // coupe par le client continuer a tourner jusqu au prochain deploiement.
    const h = harnais({ source: { ...SOURCE, status: 'disabled' } });
    const r = await h.resolveur(entree(OUTIL()));
    expect(r.ok).toBe(false);
    expect(h.ouvrirSession).not.toHaveBeenCalled();
  });

  it('une source INTROUVABLE rend un refus lisible, pas une exception', async () => {
    const h = harnais({ source: null });
    const r = await h.resolveur(entree(OUTIL()));
    expect(r.ok).toBe(false);
  });

  it('un outil SANS source est refuse plutot que d appeler dans le vide', async () => {
    const h = harnais();
    const r = await h.resolveur(entree(OUTIL({ sourceId: null })));
    expect(r.ok).toBe(false);
    expect(h.ouvrirSession).not.toHaveBeenCalled();
  });
});

describe('le resolveur MCP : ce qui REVIENT au modele', () => {
  it('rend le texte, et NE LEVE sur aucun echec', async () => {
    const h = harnais();
    const r = await h.resolveur(entree(OUTIL()));
    expect(r.ok).not.toBe(false);
    expect(JSON.stringify(r.contenu)).toContain('reponse du serveur');
  });

  it('isError:true est un echec METIER : ok:false, avec sa raison, et la source reste SAINE', async () => {
    // Le serveur a repondu, il a juste repondu non. Le marquer mort enverrait le client chercher une panne
    // qui n existe pas.
    const h = harnais({ session: { appeler: vi.fn(async () => ({ texte: 'quota depasse', estErreur: true })) } });
    const r = await h.resolveur(entree(OUTIL()));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain('quota depasse');
    expect(h.epreuves).toEqual([{ ok: true }]);
  });

  it('une panne de TRANSPORT marque la source, elle', async () => {
    const h = harnais({ session: { appeler: vi.fn(async () => ({ echec: { genre: 'reseau', message: 'ECONNREFUSED' } })) } });
    const r = await h.resolveur(entree(OUTIL()));
    expect(r.ok).toBe(false);
    expect(h.epreuves).toEqual([{ ok: false }]);
  });

  it('🔴 une nature `pousse` rend le VERDICT seul, jamais le contenu d un succes', async () => {
    // 🔴 C est une GARANTIE, pas une economie : la reponse d un outil qui AGIT porte tres souvent la
    // ressource entiere qu on vient de modifier, et l agent n a aucune raison de l envoyer au fournisseur
    // du modele.
    const h = harnais({ session: { appeler: vi.fn(async () => ({ texte: 'fiche complete du client', estErreur: false })) } });
    const r = await h.resolveur(entree(OUTIL({ nature: 'pousse' })));
    expect(r.ok).not.toBe(false);
    expect(JSON.stringify(r.contenu)).not.toContain('fiche complete');
  });

  it('la session est FERMEE, y compris quand l appel echoue', async () => {
    const h = harnais({ session: { appeler: vi.fn(async () => ({ echec: { genre: 'reseau', message: 'coupe' } })) } });
    await h.resolveur(entree(OUTIL()));
    expect(h.fermer).toHaveBeenCalled();
  });
});

describe('le bac a sable, et le libelle qui affichait deux points d interrogation', () => {
  it('🔴 il NOMME l outil et le serveur, au lieu de « l appel ? ? vers votre systeme »', async () => {
    // ⚠️ `connecteurSimule` lisait `binding.methode` et `binding.chemin`, que n a pas un outil MCP. Un bac
    // a sable qui promet de montrer ce qui va se passer et qui affiche deux points d interrogation est
    // pire qu un bac a sable absent : il a l air de fonctionner.
    const { connecteurSimule } = await import('../src/agent/resolvers/simulation');
    const r = connecteurSimule({ origin: 'mcp', binding: { outilDistant: 'search' }, outputPaths: [] });
    const texte = JSON.stringify(r.contenu);
    expect(texte).toContain('search');
    expect(texte).not.toContain('? ?');
  });

  it('🔴 il rend un TEXTE d exemple, pas un objet vide', async () => {
    // Boucler sur `outputPaths` rendrait `{}` pour un outil MCP, qui n en declare aucun par construction :
    // c est mot pour mot le defaut que 0150 a corrige pour les connecteurs HTTP.
    const { connecteurSimule } = await import('../src/agent/resolvers/simulation');
    const r = connecteurSimule({ origin: 'mcp', binding: { outilDistant: 'search' }, outputPaths: [] });
    expect(JSON.stringify(r.contenu)).toContain('exemple de ce que');
  });

  it('un connecteur HTTP garde son libelle d avant', async () => {
    // Reecrire un comportement doit CONSERVER le cas qu il exercait.
    const { connecteurSimule } = await import('../src/agent/resolvers/simulation');
    const r = connecteurSimule({ origin: 'http', binding: { methode: 'POST', chemin: '/x' }, outputPaths: ['statut'] });
    const texte = JSON.stringify(r.contenu);
    expect(texte).toContain('POST');
    expect(texte).toContain('exemple(statut)');
  });
});

describe('le CABLAGE du bac a sable, qui rendait la simulation inatteignable', () => {
  it('🔴 les TROIS origines ont un resolveur, pas seulement `mba`', async () => {
    // 🔴 LE DEFAUT QUE CE CAS FERME, ET IL ETAIT VIVANT. `src/index.ts` n enregistrait la simulation que
    // sous la cle `mba`. L executeur dispatche sur `resolveurs[outil.origin]` : un outil de CONNECTEUR y
    // produisait donc `erreur_protocole` avec `fatal: true`, un essai qui s arrete net, alors que
    // `connecteurSimule` savait parfaitement le rendre. La branche `origin !== 'mba'` etait INATTEIGNABLE.
    //
    // ⚠️ ET AUCUN TEST NE POUVAIT LE VOIR : ils appelaient `connecteurSimule` DIRECTEMENT, donc ils
    // eprouvaient la fonction et jamais le chemin. C est pour ca que la promesse de 0150 restait fausse
    // apres avoir ete reparee : elle l avait ete dans la fonction, pas dans le cablage.
    const { resolveursSimulation } = await import('../src/agent/resolvers/simulation');
    const r = resolveursSimulation({ connaissance: { chercher: async () => [] } as never });
    expect(Object.keys(r).sort()).toEqual(['http', 'mba', 'mcp']);
  });

  it('et chacune SIMULE au lieu de tomber : le chemin est reellement branche', async () => {
    const { resolveursSimulation } = await import('../src/agent/resolvers/simulation');
    const r = resolveursSimulation({ connaissance: { chercher: async () => [] } as never });
    const sortie = await r.mcp!(entree(OUTIL()));
    expect(JSON.stringify(sortie.contenu)).toContain('search');
    // Rien n est parti chez le serveur : c est tout l interet du bac a sable.
    expect(JSON.stringify(sortie.contenu)).toContain('n\'a PAS eu lieu');
  });
});
