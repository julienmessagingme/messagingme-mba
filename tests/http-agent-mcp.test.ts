import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { registerAgentMcp, type AgentMcpRouteDeps, type EcritureImportMcp } from '../src/http/agent-mcp';
import type { PreHandler } from '../src/auth/middleware';
import type { OutilExistantMcp } from '../src/agent/mcp/import';
import type { SourceAppel } from '../src/agent/sources';
import type { EchecMcp, SessionMcp } from '../src/mcp/client';

/**
 * LES ROUTES DES CONNECTEURS MCP.
 *
 * 🔴 CE QU'ELLES ACCORDENT, ET CE QUE CES CAS TIENNENT. Un serveur MCP est une adresse que NOTRE serveur
 * ira appeler depuis l'intérieur du réseau du VPS, plus un catalogue écrit par un tiers dont les
 * descriptions arrivent dans le contexte du modèle. Trois gardes, et chacune a son cas :
 * l'adresse vérifiée AVANT toute connexion, l'aperçu qui n'écrit rien, et le clouage qui désigne un champ
 * qui existe.
 */

/**
 * ⚠️ UNE GARDE QUI POSE `req.auth`, PAS UNE GARDE OUVERTE. `scopeTenant` échoue FERMÉ depuis le
 * 2026-09-03 : sans contexte d'authentification, il rend `null` et toutes les routes répondent 403. Ce
 * qu'on éprouve ici, ce sont les routes, pas l'authentification.
 */
const gardeQuiPose: PreHandler = async (req) => {
  (req as { auth?: unknown }).auth = { userId: 'moi', tenantId: TENANT, role: 'admin' };
};

const TENANT = '11111111-1111-1111-1111-111111111111';
const SOURCE = '22222222-2222-2222-2222-222222222222';
const OUTIL = '33333333-3333-3333-3333-333333333333';

const SERVEUR = {
  id: SOURCE, label: 'Notion', baseUrl: 'https://exemple.test/mcp',
  authKind: 'bearer' as const, authHeaderName: null, status: 'active',
  lastOkAt: null, lastError: null,
};
const POUR_APPEL: SourceAppel = {
  id: SOURCE, kind: 'mcp', baseUrl: 'https://exemple.test/mcp',
  authKind: 'bearer', authHeaderName: null, authSecret: 'jeton', status: 'active',
};

const annonce = (name: string, schema: unknown = { type: 'object', properties: { q: { type: 'string' } } }) =>
  ({ name, inputSchema: schema as Record<string, unknown> });

function harnais(over: {
  outils?: OutilExistantMcp[];
  catalogue?: Awaited<ReturnType<SessionMcp['lister']>>;
  resolution?: { ok: boolean; raison?: string };
  cles?: string[];
  reglerOk?: boolean;
  label?: string;
  vues?: never[];
  /** Le `kind` de la source rendue par `pourAppel` : c est ce qui distingue un serveur MCP d un connecteur API. */
  kind?: 'mcp' | 'http';
  /** Les noms DEJA pris dans l espace. L unicite de `agent_tools.name` est par ESPACE depuis 0127. */
  nomsPris?: string[];
  /** L ouverture de session echoue AVANT tout catalogue (jeton refuse, transport ancien, serveur injoignable). */
  ouverture?: { echec: EchecMcp };
  /**
   * ⚠️ LE VERDICT, PAS UN BOOLEEN, et c est ce qui rendait l ancien test DECORATIF. Le faux d avant
   * rendait `false` pour dire « il reste des outils actifs » ; le vrai store ne rend JAMAIS `false` pour
   * cette raison-la, il le rendait pour « identifiant inexistant ». Le test passait donc en eprouvant un
   * comportement que la production n a jamais eu.
   */
  suppression?: 'supprime' | 'introuvable' | 'outils_actifs';
} = {}) {
  const ecrit: EcritureImportMcp[] = [];
  const crees: unknown[] = [];
  const epreuves: Array<{ ok: boolean }> = [];
  const regles: unknown[] = [];
  /**
   * ⚠️ IL SATISFAIT `SessionMcp` EN ENTIER, sans `as never`. Trois fixtures de ce depot ont deja passe le
   * typecheck en mentant de cette facon puis ont echoue AU RUNTIME sur un `... is not a function` : un faux
   * qui ne satisfait pas le contrat ne prouve rien du vrai. `appeler` n est pas exerce ici, mais il rend
   * quand meme ce que le contrat promet.
   */
  const session: SessionMcp = {
    lister: vi.fn(async () => over.catalogue ?? { outils: [annonce('search')], tronque: false }),
    appeler: vi.fn(async () => ({ texte: '', estErreur: false })),
    fermer: vi.fn(async () => {}),
  };
  const traces: Array<{ action: string; detail?: Record<string, unknown> }> = [];
  const deps: AgentMcpRouteDeps = {
    audit: async (_t, _a, action, _target, detail) => { traces.push({ action, detail }); },
    listerServeurs: async () => [{ ...SERVEUR, ...(over.label ? { label: over.label } : {}) }],
    creerServeur: async (_t, input) => { crees.push(input); return { ...SERVEUR, ...input }; },
    supprimerServeur: async () => over.suppression ?? 'supprime',
    pourAppel: async () => ({ ...POUR_APPEL, kind: over.kind ?? 'mcp' }),
    marquerEpreuve: async (_t, _i, ok) => { epreuves.push({ ok }); },
    outilsDuServeur: async () => over.outils ?? [],
    outilsPourEcran: async () => over.vues ?? [],
    nomsPris: async () => over.nomsPris ?? [],
    appliquer: async (_t, _s, e) => { ecrit.push(e); },
    clesDeChamps: async () => over.cles ?? ['email', 'reference'],
    reglerOutil: async (_t, id, patch) => { regles.push({ id, patch }); return over.reglerOk ?? true; },
    ouvrirSession: async () => over.ouverture ?? session,
    verifierResolution: async () => over.resolution ?? { ok: true },
  };
  const app = Fastify();
  registerAgentMcp(app, deps, gardeQuiPose);
  return { app, ecrit, epreuves, regles, session, crees, traces };
}

describe('eprouver un serveur MCP', () => {
  it('rend ok et marque la source saine', async () => {
    const h = harnais();
    const r = await h.app.inject({ method: 'POST', url: `/tenants/${TENANT}/mcp/${SOURCE}/eprouver` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(h.epreuves).toEqual([{ ok: true }]);
  });

  it('🔴 une adresse qui resout vers une adresse privee est refusee SANS connexion', async () => {
    // 🔴 L ORDRE EST LA GARDE. Posee apres l ouverture, elle serait decorative : la connexion aurait deja
    // eu lieu, donc le degat aussi. Le texte de l hote est valide a l ecriture ; ce qui se verifie ici est
    // ce vers quoi il RESOUT, qu un texte ne peut pas dire.
    const h = harnais({ resolution: { ok: false, raison: 'adresse privee' } });
    const r = await h.app.inject({ method: 'POST', url: `/tenants/${TENANT}/mcp/${SOURCE}/eprouver` });
    expect(r.json()).toEqual({ ok: false, erreur: 'adresse privee' });
    expect(h.session.lister).not.toHaveBeenCalled();
    expect(h.epreuves).toEqual([{ ok: false }]);
  });
});

describe('🔴 une source qui n est PAS un serveur MCP', () => {
  /**
   * 🔴 CE QUE CES TROIS ROUTES FAISAIENT SANS CE FILTRE. `pourAppel` ne filtre pas le `kind` : un
   * administrateur qui passait l identifiant d un CONNECTEUR API faisait POSTer une enveloppe JSON-RPC
   * `initialize` sur l API metier de son propre client, AVEC SON SECRET dans l en-tete, puis ecrivait
   * `last_error` sur la ligne de ce connecteur.
   *
   * ⚠️ ET SUR `/importer`, LE SILENCE ETAIT PIRE QUE L ERREUR : l `insert` du store garde
   * `and kind = 'mcp'`, donc zero ligne ecrite, AUCUNE erreur, et la route rendait 200 en annoncant N
   * outils crees. Un apercu qui ment sur ce qu il a applique.
   */
  for (const [nom, chemin, methode] of [
    ['eprouver', 'eprouver', 'POST'],
    ['apercu', 'apercu', 'POST'],
    ['importer', 'importer', 'POST'],
  ] as const) {
    it(`${nom} : 404 et AUCUNE connexion sortante`, async () => {
      const h = harnais({ kind: 'http' });
      const r = await h.app.inject({ method: methode, url: `/tenants/${TENANT}/mcp/${SOURCE}/${chemin}` });
      expect(r.statusCode).toBe(404);
      // 🔴 L ORDRE EST LA GARDE : une verification posee apres l ouverture serait decorative, la connexion
      // aurait deja eu lieu, donc le degat aussi.
      expect(h.session.lister, 'rien n est parti chez le client').not.toHaveBeenCalled();
      expect(h.epreuves, 'et son connecteur API n a pas ete marque en panne').toEqual([]);
      expect(h.ecrit, 'rien n a ete ecrit').toEqual([]);
    });
  }
});

describe('🔴 deux noms distants qui se normalisent pareil', () => {
  it('le nouveau prend un suffixe au lieu de faire tomber TOUT l import en 500', async () => {
    /**
     * 🔴 CE DEFAUT ETAIT UN 500 QUI ATTENDAIT SON JOUR. `planEtEcriture` retirait des noms pris ceux de
     * TOUS les outils du serveur, `inchange` compris, alors que seuls `nouveau` et `schema_change` les
     * remettent. Un outil distant NEUF se normalisant vers le nom local d un outil INCHANGE
     * (`get-contact` a cote de `get_contact`) produisait un `insert` en violation de l index unique par
     * espace de 0127, donc un rollback de TOUTE la transaction : l import entier perdu, et un 500 dont
     * Cloudflare remplace le corps.
     */
    const inchange = {
      id: '33333333-3333-3333-3333-333333333333',
      name: 'notion_get_contact',
      nomDistant: 'get_contact',
      mcpAnnonce: annonce('get_contact'),
      mcpIndisponibleLe: null,
      params: [],
      consommateursActifs: 0,
    };
    const h = harnais({
      outils: [inchange],
      nomsPris: ['notion_get_contact'],
      // Le serveur annonce l ancien A L IDENTIQUE (donc « inchange ») et un NOUVEAU qui se normalise pareil.
      catalogue: { outils: [annonce('get_contact'), annonce('get-contact')], tronque: false },
    });
    const r = await h.app.inject({ method: 'POST', url: `/tenants/${TENANT}/mcp/${SOURCE}/importer` });
    expect(r.statusCode).toBe(200);
    const nouveaux = h.ecrit[0]!.nouveaux.map((o) => o.name);
    expect(nouveaux, 'le neuf ne reprend pas le nom local de l inchange').not.toContain('notion_get_contact');
    expect(nouveaux[0]).toMatch(/^notion_get_contact_\d+$/);
  });
});

describe('🔴 declarer et supprimer un serveur laissent une trace dans l AUDIT', () => {
  /**
   * 🔴 UN SERVEUR MCP EST UNE SORTIE DE L ESPACE, au meme titre qu un connecteur API : le declarer ecrit
   * une adresse sortante et un secret, le supprimer emporte par cascade ses outils et TOUS les
   * consentements. Aucun de ces gestes ne laissait la moindre ligne dans « Securite > Audit », alors que
   * le module jumeau en ecrit trois et que le commentaire de la route de suppression annonce « exactement
   * comme un connecteur API ». Releve par la seconde relecture a froid du 2026-09-17.
   */
  it('la creation journalise le MODE et l HOTE, jamais le secret ni l adresse complete', async () => {
    const h = harnais();
    await h.app.inject({
      method: 'POST', url: `/tenants/${TENANT}/mcp`,
      payload: { label: 'Notion', baseUrl: 'https://exemple.test/mcp/v1?x=1', authKind: 'bearer', authSecret: 'tres-secret' },
    });
    expect(h.traces.map((t) => t.action)).toContain('connecteur.cree');
    const detail = h.traces.find((t) => t.action === 'connecteur.cree')!.detail!;
    expect(detail.hote).toBe('exemple.test');
    // 🔴 NI LE SECRET NI LE CHEMIN : cette table ne se purge pas, et le chemin complet donnerait de quoi
    // rejouer l appel.
    expect(JSON.stringify(detail)).not.toContain('tres-secret');
    expect(JSON.stringify(detail)).not.toContain('/mcp/v1');
  });

  it('la suppression journalise, et un REFUS ne journalise rien', async () => {
    const ok = harnais();
    await ok.app.inject({ method: 'DELETE', url: `/tenants/${TENANT}/mcp/${SOURCE}` });
    expect(ok.traces.map((t) => t.action)).toContain('connecteur.supprime');

    // La preuve inverse : un geste REFUSE ne doit pas laisser croire qu il a eu lieu.
    const refuse = harnais({ suppression: 'outils_actifs' });
    await refuse.app.inject({ method: 'DELETE', url: `/tenants/${TENANT}/mcp/${SOURCE}` });
    expect(refuse.traces).toEqual([]);
  });
});

describe('l apercu et l import', () => {
  it('🔴 l apercu N EST PAS un GET : il ouvre une connexion sortante et ecrit', async () => {
    /**
     * « Sans rien ecrire » ne parlait que du CATALOGUE. Ce chemin appelle le serveur du client et pose
     * `marquerEpreuve` : en GET, un prechargement de navigateur, un apercu de lien, une nouvelle tentative
     * automatique ou un robot suffisaient a declencher les deux, sans que personne ait clique.
     */
    const h = harnais();
    const r = await h.app.inject({ method: 'GET', url: `/tenants/${TENANT}/mcp/${SOURCE}/apercu` });
    expect(r.statusCode).toBe(404);
    expect(h.session.lister, 'aucune connexion sortante n a eu lieu').not.toHaveBeenCalled();
  });

  it('🔴 l APERCU n ECRIT RIEN', async () => {
    // 🔴 C est tout l interet de la paire : ecraser n est acceptable que si l on montre QUOI avant de le
    // faire, suppressions comprises. Un apercu qui ecrirait serait un import qui ment sur son nom.
    const h = harnais();
    const r = await h.app.inject({ method: 'POST', url: `/tenants/${TENANT}/mcp/${SOURCE}/apercu` });
    expect(r.statusCode).toBe(200);
    expect(r.json().plan).toEqual([{ type: 'nouveau', nom: 'search' }]);
    expect(h.ecrit).toEqual([]);
  });

  it('l IMPORT applique le MEME plan', async () => {
    // Deux calculs separes finiraient par diverger, et le client validerait alors un plan qui n est pas
    // celui qui s execute. Les deux routes passent par la meme fonction.
    const h = harnais();
    const r = await h.app.inject({ method: 'POST', url: `/tenants/${TENANT}/mcp/${SOURCE}/importer` });
    expect(r.json().plan).toEqual([{ type: 'nouveau', nom: 'search' }]);
    expect(h.ecrit).toHaveLength(1);
    expect(h.ecrit[0]!.nouveaux.map((o) => [o.nomDistant, o.name])).toEqual([['search', 'notion_search']]);
  });

  it('🔴 un catalogue TRONQUE le dit, et n emporte AUCUNE disparition', async () => {
    // 🔴 La liste EST partielle, legitimement. Marquer « disparu » ce qui n y figure pas ferait tomber le
    // consentement de tout ce qui vivait au dela de la borne.
    const existant: OutilExistantMcp = {
      id: OUTIL, name: 'notion_autre', nomDistant: 'autre',
      mcpAnnonce: annonce('autre'), mcpIndisponibleLe: null, params: [], consommateursActifs: 3,
    };
    const h = harnais({ catalogue: { outils: [annonce('search')], tronque: true }, outils: [existant] });
    const r = await h.app.inject({ method: 'POST', url: `/tenants/${TENANT}/mcp/${SOURCE}/importer` });
    expect(r.json().tronque).toBe(true);
    expect(r.json().plan.some((c: { type: string }) => c.type === 'disparu')).toBe(false);
    expect(h.ecrit[0]!.disparus).toEqual([]);
  });

  /**
   * 🔴 422, JAMAIS 5xx, ET C EST LA RAISON QUE L ADMINISTRATEUR DOIT LIRE. L API est servie derriere
   * Cloudflare, qui remplace le corps de tout 5xx par sa propre page : en 502, la cause que nous
   * connaissions (« injoignable », « jeton refuse ») n arrivait jamais a l ecran, qui affichait
   * « Erreur 502 ». Meme regle que le test d une boite SMTP (`src/http/email.ts`).
   */
  it('🔴 un catalogue illisible rend 422 AVEC sa raison, marque la source, et n ecrit pas', async () => {
    const h = harnais({ catalogue: { echec: { genre: 'reseau', message: 'coupe' } } });
    const r = await h.app.inject({ method: 'POST', url: `/tenants/${TENANT}/mcp/${SOURCE}/importer` });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toEqual({ error: 'le serveur est injoignable' });
    expect(h.ecrit).toEqual([]);
    expect(h.epreuves).toEqual([{ ok: false }]);
  });

  it('🔴 un echec AVANT le catalogue rend lui aussi 422 avec sa raison, sur l apercu comme sur l import', async () => {
    // Deux portes avant `lister` : l adresse qui resout vers l interieur, et la session qui ne s ouvre
    // pas. Elles passaient par le MEME 502 que le catalogue illisible, et aucun cas ne les tenait.
    const cas = [
      [{ resolution: { ok: false, raison: 'adresse privee' } }, 'adresse privee'],
      [{ ouverture: { echec: { genre: 'refus' as const, code: 401, message: 'le serveur a répondu 401' } } }, 'le serveur a refusé la connexion (401)'],
      [{ ouverture: { echec: { genre: 'transport_ancien' as const } } }, 'ancien transport HTTP+SSE'],
    ] as const;
    for (const route of ['apercu', 'importer']) {
      for (const [over, attendu] of cas) {
        const h = harnais(over);
        const r = await h.app.inject({ method: 'POST', url: `/tenants/${TENANT}/mcp/${SOURCE}/${route}` });
        expect(r.statusCode, `${route} ${attendu}`).toBe(422);
        expect(r.json().error, `${route} ${attendu}`).toContain(attendu);
        expect(h.session.lister).not.toHaveBeenCalled();
        expect(h.ecrit).toEqual([]);
        expect(h.epreuves).toEqual([{ ok: false }]);
      }
    }
  });

  it('🔴 un refus d adresse interne et une redirection disent CHACUN leur cause a l administrateur', async () => {
    for (const [echec, attendu] of [
      [{ genre: 'adresse_interne' as const }, 'ne résout pas vers une adresse publique'],
      [{ genre: 'redirection' as const }, 'a redirigé l’appel'],
    ] as const) {
      const h = harnais({ catalogue: { echec } });
      const r = await h.app.inject({ method: 'POST', url: `/tenants/${TENANT}/mcp/${SOURCE}/importer` });
      expect(r.statusCode, echec.genre).toBe(422);
      expect(r.body, echec.genre).toContain(attendu);
    }
  });

  it('⚠️ un outil dont le schema a change GARDE son nom local', async () => {
    // Le nom local est peut-etre deja ecrit dans une consigne d agent : le changer casserait ce que le
    // client a redige, pour une raison qui ne le regarde pas.
    //
    // 🔴 LE SERVEUR EST RENOMME DANS CE CAS, ET C EST CE QUI LE REND PROBANT. Avec le meme libelle, le
    // nom recalcule tombe sur le meme que le nom stocke : l assertion passe alors dans les DEUX sens et
    // ne prouve rien. Une mutation l a montre. Ici « Notion » est devenu « Notion Prod », donc un
    // recalcul donnerait `notion_prod_search`, et seul le fait de CONSERVER rend `notion_search`.
    const existant: OutilExistantMcp = {
      id: OUTIL, name: 'notion_search', nomDistant: 'search',
      mcpAnnonce: annonce('search', { type: 'object', properties: {} }),
      mcpIndisponibleLe: null, params: [], consommateursActifs: 1,
    };
    const h = harnais({ outils: [existant], label: 'Notion Prod' });
    await h.app.inject({ method: 'POST', url: `/tenants/${TENANT}/mcp/${SOURCE}/importer` });
    expect(h.ecrit[0]!.changes).toHaveLength(1);
    expect(h.ecrit[0]!.changes[0]!.outil.name).toBe('notion_search');
  });

  it('un identifiant qui n est pas un uuid est refuse avant toute lecture', async () => {
    const h = harnais();
    const r = await h.app.inject({ method: 'POST', url: `/tenants/${TENANT}/mcp/pas-un-uuid/apercu` });
    expect(r.statusCode).toBe(400);
  });
});

describe('regler un outil importe', () => {
  it('🔴 un clouage sur un champ INEXISTANT est refuse, avec le nom du champ', async () => {
    // 🔴 La faute de frappe se voit a la configuration, pas en pleine conversation. Sans ce cas, un
    // parametre cloue a une cle que personne n a creee partirait VIDE a chaque appel, en silence.
    const h = harnais({ cles: ['email'] });
    const r = await h.app.inject({
      method: 'PATCH', url: `/tenants/${TENANT}/mcp/outils/${OUTIL}`,
      payload: { params: [{ name: 'client', source: 'champ', cle: 'referenc' }] },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain('referenc');
    expect(h.regles).toEqual([]);
  });

  it('un clouage sur un champ DECLARE passe', async () => {
    const h = harnais({ cles: ['email'] });
    const r = await h.app.inject({
      method: 'PATCH', url: `/tenants/${TENANT}/mcp/outils/${OUTIL}`,
      payload: { params: [{ name: 'client', source: 'champ', cle: 'email' }] },
    });
    expect(r.statusCode).toBe(200);
    expect(h.regles).toHaveLength(1);
  });

  it('🔴 un `champ` SANS cle est refuse : il ne designerait rien', async () => {
    const h = harnais();
    const r = await h.app.inject({
      method: 'PATCH', url: `/tenants/${TENANT}/mcp/outils/${OUTIL}`,
      payload: { params: [{ name: 'client', source: 'champ' }] },
    });
    expect(r.statusCode).toBe(400);
    expect(h.regles).toEqual([]);
  });

  it('🔴 un `fixe` SANS valeur est refuse, pour la meme raison', async () => {
    const h = harnais();
    const r = await h.app.inject({
      method: 'PATCH', url: `/tenants/${TENANT}/mcp/outils/${OUTIL}`,
      payload: { params: [{ name: 'boutique', source: 'fixe' }] },
    });
    expect(r.statusCode).toBe(400);
    expect(h.regles).toEqual([]);
  });

  it('un outil qui n est pas de cet espace rend 404', async () => {
    const h = harnais({ reglerOk: false });
    const r = await h.app.inject({
      method: 'PATCH', url: `/tenants/${TENANT}/mcp/outils/${OUTIL}`, payload: { risk: 'read' },
    });
    expect(r.statusCode).toBe(404);
  });
});

describe('lister les outils importes', () => {
  it('🔴 la route EXISTE, sinon l ecran ne peut rien regler', async () => {
    // 🔴 LE MANQUE QUE LA TACHE 8 A REVELE. L import ecrivait des outils que personne ne pouvait ni voir ni
    // clouer : une capacite ecrite sans son lecteur, c est-a-dire le motif « offert-et-inerte » que ce
    // produit s interdit ailleurs.
    const h = harnais();
    const r = await h.app.inject({ method: 'GET', url: `/tenants/${TENANT}/mcp/${SOURCE}/outils` });
    expect(r.statusCode).toBe(200);
    expect(r.json().outils).toEqual([]);
  });

  it('refuse un identifiant qui n est pas un uuid', async () => {
    const h = harnais();
    const r = await h.app.inject({ method: 'GET', url: `/tenants/${TENANT}/mcp/pas-un-uuid/outils` });
    expect(r.statusCode).toBe(400);
  });
});

describe('le clouage `contact`, qui etait INERTE', () => {
  it('🔴 un `contact` SANS contactPath est REFUSE', async () => {
    // 🔴 L executeur calcule `p.contactPath ?? p.name` : pour un parametre distant nomme `client_id`, il
    // chercherait `ctx.contact['client_id']`, qui n existe pas, et enverrait `null`. Le client croirait
    // avoir cloue l identifiant, l appel partirait vide, et la reaction naturelle serait de repasser en
    // « l agent decide », c est-a-dire d ouvrir le trou qu il cherchait a fermer.
    const h = harnais();
    const r = await h.app.inject({
      method: 'PATCH', url: `/tenants/${TENANT}/mcp/outils/${OUTIL}`,
      payload: { params: [{ name: 'client_id', source: 'contact' }] },
    });
    expect(r.statusCode).toBe(400);
    // ⚠️ LE MESSAGE COMPTE, PAS SEULEMENT LE CODE. Une mutation l a montre : `estChampContact(undefined)`
    // rend deja `false`, donc retirer cette garde-la laissait quand meme un 400 partir, avec le message de
    // l AUTRE cas. Or « vous n avez rien choisi » et « ce que vous avez choisi n existe pas » n envoient
    // pas le client au meme endroit.
    expect(r.json().error).toContain('doit désigner');
    expect(h.regles).toEqual([]);
  });

  it('🔴 un contactPath HORS de la liste fermee est REFUSE', async () => {
    // 🔴 Cette route est le PREMIER ecrivain de `source: contact` du depot. Sans cette garde, un
    // `contactPath: 'champs'` ferait partir TOUT le jsonb des champs personnalises du contact vers le
    // serveur tiers, et `'tags'` le tableau de tags. `champs-contact.ts` se declare « FERMEE EXPRES ».
    const h = harnais();
    for (const mauvais of ['champs', 'tags', 'opt_in']) {
      const r = await h.app.inject({
        method: 'PATCH', url: `/tenants/${TENANT}/mcp/outils/${OUTIL}`,
        payload: { params: [{ name: 'client_id', source: 'contact', contactPath: mauvais }] },
      });
      expect(r.statusCode, mauvais).toBe(400);
      expect(r.json().error, mauvais).toContain('n’est pas un attribut');
    }
    expect(h.regles).toEqual([]);
  });

  it('un contactPath de la liste passe', async () => {
    const h = harnais();
    const r = await h.app.inject({
      method: 'PATCH', url: `/tenants/${TENANT}/mcp/outils/${OUTIL}`,
      payload: { params: [{ name: 'client_id', source: 'contact', contactPath: 'wa_id' }] },
    });
    expect(r.statusCode).toBe(200);
    expect(h.regles).toHaveLength(1);
  });

  it('la route rend les DEUX listes de clouage, pour que l ecran ne les recopie pas', async () => {
    // Une liste recopiee cote navigateur finirait par proposer ce que le serveur refuse, et le client
    // verrait un refus sur une valeur qu on venait de lui suggerer.
    const h = harnais({ cles: ['email', 'reference'] });
    const r = await h.app.inject({ method: 'GET', url: `/tenants/${TENANT}/mcp/${SOURCE}/outils` });
    expect(r.json().champs).toEqual(['email', 'reference']);
    expect(r.json().champsContact).toEqual(['wa_id', 'nom']);
  });
});

describe('declarer un serveur MCP', () => {
  it('🔴 LA ROUTE EXISTE : sans elle, personne ne peut declarer de serveur MCP', async () => {
    // 🔴 LE DEFAUT QUE CE CAS FERME, ET IL RENDAIT TOUT LE LOT INUTILISABLE. La route des connecteurs API
    // code `kind: 'http'` en dur et n accepte aucun champ `kind` ; c est le SEUL insert dans
    // `agent_tool_sources` du depot. `listerServeurs` filtrant sur `kind = 'mcp'` rendait donc TOUJOURS
    // zero ligne, et les quatre autres routes de ce module etaient du cablage sans producteur.
    const h = harnais();
    const r = await h.app.inject({
      method: 'POST', url: `/tenants/${TENANT}/mcp`,
      payload: { label: 'Notion', baseUrl: 'https://exemple.test/mcp', authKind: 'bearer', authSecret: 'jeton' },
    });
    expect(r.statusCode).toBe(201);
    expect(h.crees[0]).toMatchObject({ label: 'Notion', baseUrl: 'https://exemple.test/mcp', authKind: 'bearer' });
  });

  it('🔴 une adresse non publique ou non HTTPS est refusee A L ECRITURE', async () => {
    // La refuser au moment de l appel reviendrait a la decouvrir en pleine conversation avec un contact.
    const h = harnais();
    for (const mauvaise of ['http://exemple.test/mcp', 'https://localhost/mcp', 'https://127.0.0.1/mcp']) {
      const r = await h.app.inject({
        method: 'POST', url: `/tenants/${TENANT}/mcp`,
        payload: { label: 'X', baseUrl: mauvaise, authKind: 'none' },
      });
      expect(r.statusCode, mauvaise).toBe(400);
    }
    expect(h.crees).toEqual([]);
  });

  it('un mode d authentification sans secret est refuse', async () => {
    // Rejoue ici parce que la contrainte de 0088 refuserait de toute facon, mais en 500, dont Cloudflare
    // remplace le corps.
    const h = harnais();
    const r = await h.app.inject({
      method: 'POST', url: `/tenants/${TENANT}/mcp`,
      payload: { label: 'X', baseUrl: 'https://exemple.test/mcp', authKind: 'bearer' },
    });
    expect(r.statusCode).toBe(400);
    expect(h.crees).toEqual([]);
  });

  it('⚠️ supprimer un serveur qui porte des outils ACTIFS est refuse en 409', async () => {
    // La cascade ferait disparaitre les outils sans bruit, et l agent deviendrait muet sur ces gestes-la,
    // en production, sans que personne ne l ait decide.
    const h = harnais({ suppression: 'outils_actifs' });
    const r = await h.app.inject({ method: 'DELETE', url: `/tenants/${TENANT}/mcp/${SOURCE}` });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain('outils actifs');
  });

  it('🔴 et un serveur INTROUVABLE rend 404, pas le refus qui parle d outils actifs', async () => {
    // C est le defaut exact que le booleen cachait : les deux cas rendaient le MEME `false`, donc le seul
    // 409 que la production savait produire etait celui d un identifiant qui n existe pas, pendant qu un
    // serveur reellement utilise se supprimait avec ses outils. Deux valeurs qui se ressemblaient sous un
    // meme retour, et elles ne voulaient pas dire la meme chose.
    const h = harnais({ suppression: 'introuvable' });
    const r = await h.app.inject({ method: 'DELETE', url: `/tenants/${TENANT}/mcp/${SOURCE}` });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).not.toContain('outils actifs');
  });

  it('un serveur sans outil actif se supprime', async () => {
    const h = harnais();
    const r = await h.app.inject({ method: 'DELETE', url: `/tenants/${TENANT}/mcp/${SOURCE}` });
    expect(r.statusCode).toBe(204);
  });
});
