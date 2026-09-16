import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { registerAgentMcp, type AgentMcpRouteDeps, type EcritureImportMcp } from '../src/http/agent-mcp';
import type { PreHandler } from '../src/auth/middleware';
import type { OutilExistantMcp } from '../src/agent/mcp/import';

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
const POUR_APPEL = {
  id: SOURCE, baseUrl: 'https://exemple.test/mcp',
  authKind: 'bearer' as const, authHeaderName: null, authSecret: 'jeton', status: 'active' as const,
};

const annonce = (name: string, schema: unknown = { type: 'object', properties: { q: { type: 'string' } } }) =>
  ({ name, inputSchema: schema as Record<string, unknown> });

function harnais(over: {
  outils?: OutilExistantMcp[];
  catalogue?: unknown;
  resolution?: { ok: boolean; raison?: string };
  cles?: string[];
  reglerOk?: boolean;
  label?: string;
} = {}) {
  const ecrit: EcritureImportMcp[] = [];
  const epreuves: Array<{ ok: boolean }> = [];
  const regles: unknown[] = [];
  const session = {
    lister: vi.fn(async () => over.catalogue ?? { outils: [annonce('search')], tronque: false }),
    appeler: vi.fn(),
    fermer: vi.fn(async () => {}),
  };
  const deps: AgentMcpRouteDeps = {
    listerServeurs: async () => [{ ...SERVEUR, ...(over.label ? { label: over.label } : {}) }],
    pourAppel: async () => POUR_APPEL,
    marquerEpreuve: async (_t, _i, ok) => { epreuves.push({ ok }); },
    outilsDuServeur: async () => over.outils ?? [],
    nomsPris: async () => [],
    appliquer: async (_t, _s, e) => { ecrit.push(e); },
    clesDeChamps: async () => over.cles ?? ['email', 'reference'],
    reglerOutil: async (_t, id, patch) => { regles.push({ id, patch }); return over.reglerOk ?? true; },
    ouvrirSession: (async () => session) as never,
    verifierResolution: async () => (over.resolution ?? { ok: true }) as never,
  };
  const app = Fastify();
  registerAgentMcp(app, deps, gardeQuiPose);
  return { app, ecrit, epreuves, regles, session };
}

describe('eprouver un serveur MCP', () => {
  it('rend ok et marque la source saine', async () => {
    const h = harnais();
    const r = await h.app.inject({ method: 'POST', url: `/agents/${TENANT}/mcp/${SOURCE}/eprouver` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(h.epreuves).toEqual([{ ok: true }]);
  });

  it('🔴 une adresse qui resout vers une adresse privee est refusee SANS connexion', async () => {
    // 🔴 L ORDRE EST LA GARDE. Posee apres l ouverture, elle serait decorative : la connexion aurait deja
    // eu lieu, donc le degat aussi. Le texte de l hote est valide a l ecriture ; ce qui se verifie ici est
    // ce vers quoi il RESOUT, qu un texte ne peut pas dire.
    const h = harnais({ resolution: { ok: false, raison: 'adresse privee' } });
    const r = await h.app.inject({ method: 'POST', url: `/agents/${TENANT}/mcp/${SOURCE}/eprouver` });
    expect(r.json()).toEqual({ ok: false, erreur: 'adresse privee' });
    expect(h.session.lister).not.toHaveBeenCalled();
    expect(h.epreuves).toEqual([{ ok: false }]);
  });
});

describe('l apercu et l import', () => {
  it('🔴 l APERCU n ECRIT RIEN', async () => {
    // 🔴 C est tout l interet de la paire : ecraser n est acceptable que si l on montre QUOI avant de le
    // faire, suppressions comprises. Un apercu qui ecrirait serait un import qui ment sur son nom.
    const h = harnais();
    const r = await h.app.inject({ method: 'GET', url: `/agents/${TENANT}/mcp/${SOURCE}/apercu` });
    expect(r.statusCode).toBe(200);
    expect(r.json().plan).toEqual([{ type: 'nouveau', nom: 'search' }]);
    expect(h.ecrit).toEqual([]);
  });

  it('l IMPORT applique le MEME plan', async () => {
    // Deux calculs separes finiraient par diverger, et le client validerait alors un plan qui n est pas
    // celui qui s execute. Les deux routes passent par la meme fonction.
    const h = harnais();
    const r = await h.app.inject({ method: 'POST', url: `/agents/${TENANT}/mcp/${SOURCE}/importer` });
    expect(r.json().plan).toEqual([{ type: 'nouveau', nom: 'search' }]);
    expect(h.ecrit).toHaveLength(1);
    expect(h.ecrit[0]!.nouveaux.map((o) => [o.nomDistant, o.name])).toEqual([['search', 'notion_search']]);
  });

  it('🔴 un catalogue TRONQUE le dit, et n emporte AUCUNE disparition', async () => {
    // 🔴 La liste EST partielle, legitimement. Marquer « disparu » ce qui n y figure pas ferait tomber le
    // consentement de tout ce qui vivait au dela de la borne.
    const existant: OutilExistantMcp = {
      id: OUTIL, name: 'notion_autre', nomDistant: 'autre',
      mcpAnnonce: annonce('autre'), mcpIndisponibleLe: null, consommateursActifs: 3,
    };
    const h = harnais({ catalogue: { outils: [annonce('search')], tronque: true }, outils: [existant] });
    const r = await h.app.inject({ method: 'POST', url: `/agents/${TENANT}/mcp/${SOURCE}/importer` });
    expect(r.json().tronque).toBe(true);
    expect(r.json().plan.some((c: { type: string }) => c.type === 'disparu')).toBe(false);
    expect(h.ecrit[0]!.disparus).toEqual([]);
  });

  it('un catalogue illisible rend 502 et marque la source, il n ecrit pas', async () => {
    const h = harnais({ catalogue: { echec: { genre: 'reseau', message: 'coupe' } } });
    const r = await h.app.inject({ method: 'POST', url: `/agents/${TENANT}/mcp/${SOURCE}/importer` });
    expect(r.statusCode).toBe(502);
    expect(h.ecrit).toEqual([]);
    expect(h.epreuves).toEqual([{ ok: false }]);
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
      mcpIndisponibleLe: null, consommateursActifs: 1,
    };
    const h = harnais({ outils: [existant], label: 'Notion Prod' });
    await h.app.inject({ method: 'POST', url: `/agents/${TENANT}/mcp/${SOURCE}/importer` });
    expect(h.ecrit[0]!.changes).toHaveLength(1);
    expect(h.ecrit[0]!.changes[0]!.outil.name).toBe('notion_search');
  });

  it('un identifiant qui n est pas un uuid est refuse avant toute lecture', async () => {
    const h = harnais();
    const r = await h.app.inject({ method: 'GET', url: `/agents/${TENANT}/mcp/pas-un-uuid/apercu` });
    expect(r.statusCode).toBe(400);
  });
});

describe('regler un outil importe', () => {
  it('🔴 un clouage sur un champ INEXISTANT est refuse, avec le nom du champ', async () => {
    // 🔴 La faute de frappe se voit a la configuration, pas en pleine conversation. Sans ce cas, un
    // parametre cloue a une cle que personne n a creee partirait VIDE a chaque appel, en silence.
    const h = harnais({ cles: ['email'] });
    const r = await h.app.inject({
      method: 'PATCH', url: `/agents/${TENANT}/mcp/outils/${OUTIL}`,
      payload: { params: [{ name: 'client', source: 'champ', cle: 'referenc' }] },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain('referenc');
    expect(h.regles).toEqual([]);
  });

  it('un clouage sur un champ DECLARE passe', async () => {
    const h = harnais({ cles: ['email'] });
    const r = await h.app.inject({
      method: 'PATCH', url: `/agents/${TENANT}/mcp/outils/${OUTIL}`,
      payload: { params: [{ name: 'client', source: 'champ', cle: 'email' }] },
    });
    expect(r.statusCode).toBe(200);
    expect(h.regles).toHaveLength(1);
  });

  it('🔴 un `champ` SANS cle est refuse : il ne designerait rien', async () => {
    const h = harnais();
    const r = await h.app.inject({
      method: 'PATCH', url: `/agents/${TENANT}/mcp/outils/${OUTIL}`,
      payload: { params: [{ name: 'client', source: 'champ' }] },
    });
    expect(r.statusCode).toBe(400);
    expect(h.regles).toEqual([]);
  });

  it('🔴 un `fixe` SANS valeur est refuse, pour la meme raison', async () => {
    const h = harnais();
    const r = await h.app.inject({
      method: 'PATCH', url: `/agents/${TENANT}/mcp/outils/${OUTIL}`,
      payload: { params: [{ name: 'boutique', source: 'fixe' }] },
    });
    expect(r.statusCode).toBe(400);
    expect(h.regles).toEqual([]);
  });

  it('un outil qui n est pas de cet espace rend 404', async () => {
    const h = harnais({ reglerOk: false });
    const r = await h.app.inject({
      method: 'PATCH', url: `/agents/${TENANT}/mcp/outils/${OUTIL}`, payload: { risk: 'read' },
    });
    expect(r.statusCode).toBe(404);
  });
});
