import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { OutilBibliotheque } from '../src/agent/catalog';
import { FakeQueue } from '../src/queue/fake';

/**
 * La bibliothèque d'outils d'un espace.
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : le REFUS de supprimer une définition encore rattachée. La contrainte de la
 * migration 0127 est en `on delete cascade` : sans ce refus applicatif, la suppression emporterait en
 * silence le consentement d'agents qu'on ne regardait pas, et l'écran annoncerait un succès.
 */
const TENANT = 't1';
const OUTIL = '22222222-2222-4222-8222-222222222222';
const SECRET = 'test-secret';
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };

let adminTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: TENANT, role: 'admin' }, SECRET);
});

/**
 * ⚠️ UN VRAI JETON, PAS UN MONTAGE SANS GARDE. `scopeTenant` ÉCHOUE FERMÉ depuis le 2026-09-03 : sans
 * `req.auth`, elle rend `null` et toute route répond 403. Monter ce module « nu » testerait donc uniquement
 * le refus, ce qui a l'air vert et ne prouve rien.
 *
 * ⚠️ ET C'EST UNE FONCTION, PAS UNE CONSTANTE : un objet figé au chargement du module capturerait `adminTok`
 * ALORS QU'IL EST ENCORE VIDE (il est signé dans `beforeAll`), et chaque appel partirait avec un
 * « Bearer  » vide, donc un 401 partout. Même forme que `tests/http-agent-tools.test.ts`.
 */
const h = (): { headers: Record<string, string> } => ({
  headers: { 'content-type': 'application/json', authorization: `Bearer ${adminTok}` },
});

const BIB: OutilBibliotheque = {
  id: OUTIL, name: 'lire_commande', title: 'Lire', description: 'lit une commande',
  origin: 'mba', risk: 'read', sourceId: null,
  consommateurs: [
    { cle: `agent:${OUTIL}`, actif: true, agentId: OUTIL, agentLabel: 'Support' },
    { cle: 'mba:1234840649713976', actif: false, agentId: null, agentLabel: null },
  ],
};

function monter(verdict: 'ok' | 'rattachee' | 'introuvable', numero: string | null = '1234840649713976') {
  const supprimes: string[][] = [];
  const gestes: string[] = [];
  const crees: Array<{ pn: string; outil: Record<string, unknown> }> = [];
  const app = buildServer({
    queue: new FakeQueue(),
    auth: { users: noUsers, secret: SECRET },
    agentCatalogue: {
      listCatalogue: async () => [BIB],
      supprimerDefinition: async (t, id) => { supprimes.push([t, id]); return verdict; },
      numeroDuTenant: async () => numero,
      rattacherConsommateur: async (_t, cle, id) => { gestes.push(`rattache:${cle}:${id}`); return true; },
      detacherConsommateur: async (_t, cle, id) => { gestes.push(`detache:${cle}:${id}`); return true; },
      activerConsommateur: async (_t, cle, id, actif, par) => {
        gestes.push(`active:${cle}:${id}:${actif}:${par}`);
        return {};
      },
      creerPourMba: async (_t, pn, outil) => {
        crees.push({ pn, outil: outil as unknown as Record<string, unknown> });
        return { id: CREE };
      },
      requetePourOutil: async (_t, id) => (id === REQ ? REQUETE : null),
    },
  });
  return { app, supprimes, gestes, crees };
}

const REQ = '33333333-3333-4333-8333-333333333333';
const CREE = '44444444-4444-4444-8444-444444444444';

/** ⚠️ Un DELETE, volontairement : c'est ce qui prouve que le risque plancher est DÉRIVÉ de la méthode. */
const REQUETE = {
  id: REQ, sourceId: '55555555-5555-4555-8555-555555555555', methode: 'DELETE',
  variables: [
    { nom: 'ref', type: 'string', origine: { type: 'modele' }, requis: true },
    { nom: 'ville', type: 'string', origine: { type: 'champ' } },
  ],
};

const corpsMba = (over: Record<string, unknown> = {}) => ({
  requeteId: REQ, name: 'poser_etiquette', title: 'Poser',
  description: 'pose une étiquette', nePasUtiliser: 'jamais pour retirer',
  ...over,
});

describe('créer un outil DIRECTEMENT pour l’agent de Meta', () => {
  /**
   * 🔴 CE CHEMIN N'EXISTAIT PAS, ET SON ABSENCE SE PAYAIT EN CORVÉE. Un outil naissait en le donnant à un
   * agent IA : exposer un appel à Meta obligeait donc à créer un agent dont on n'a pas besoin, puis à
   * répondre pour lui à des questions que Meta ignore. Julien, 2026-09-15 : « je ne sais pas où l'affecter
   * pour le MBA ».
   *
   * ⚠️ ET IL N'A DEMANDÉ AUCUNE MIGRATION, ce qui a été MESURÉ en base : `agent_tools.agent_id` n'existe plus
   * depuis 0128, un outil appartient déjà à l'espace, et seule la ligne de consommateur le rattache.
   */
  it('🔴 crée l’outil ET l’expose, en un seul geste', async () => {
    // Le MBA n'a pas d'écran de relecture chez nous : un état « créé mais éteint » ne s'afficherait nulle part.
    const { app, gestes, crees } = monter('ok');
    const res = await app.inject({ method: 'POST', url: `/tenants/${TENANT}/agent-tools/connecteur-mba`, ...h(), payload: corpsMba() });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: CREE, expose: true, consommateur: 'mba:1234840649713976' });
    expect(gestes).toContain(`active:mba:1234840649713976:${CREE}:true:u1`);
  });

  it('🔴 le risque est DÉRIVÉ de la méthode, jamais accepté du navigateur', async () => {
    // Un client qui déclarerait « read » sur un DELETE désarmerait la garde d'autonomie.
    const { app, crees } = monter('ok');
    await app.inject({ method: 'POST', url: `/tenants/${TENANT}/agent-tools/connecteur-mba`, ...h(), payload: corpsMba({ risk: 'read' }) });
    expect(crees[0]!.outil).toMatchObject({ risk: 'irreversible' });
  });

  it('🔴 le MODÈLE ne voit que les variables qu’il doit remplir', async () => {
    // Exposer une variable résolue par le serveur (un champ du contact) inviterait le modèle de Meta à la
    // fournir lui-même, donc à désigner la ressource de quelqu'un d'autre. C'est la garde anti-IDOR.
    const { app, crees } = monter('ok');
    await app.inject({ method: 'POST', url: `/tenants/${TENANT}/agent-tools/connecteur-mba`, ...h(), payload: corpsMba() });
    expect(crees[0]!.outil.params).toEqual([{ name: 'ref', type: 'string', source: 'modele', required: true }]);
  });

  it('🔴 sans numéro connecté, 409 avec la raison, et RIEN n’est créé', async () => {
    const { app, crees } = monter('ok', null);
    const res = await app.inject({ method: 'POST', url: `/tenants/${TENANT}/agent-tools/connecteur-mba`, ...h(), payload: corpsMba() });
    expect(res.statusCode).toBe(409);
    expect(crees).toEqual([]);
  });

  it('🔴 une requête d’un AUTRE espace rend 404, et rien n’est écrit', async () => {
    const { app, crees } = monter('ok');
    const res = await app.inject({
      method: 'POST', url: `/tenants/${TENANT}/agent-tools/connecteur-mba`, ...h(),
      payload: corpsMba({ requeteId: '66666666-6666-4666-8666-666666666666' }),
    });
    expect(res.statusCode).toBe(404);
    expect(crees).toEqual([]);
  });

  it('⚠️ un nom technique mal formé est refusé : c’est ce que le modèle de Meta verra', async () => {
    const { app } = monter('ok');
    const res = await app.inject({ method: 'POST', url: `/tenants/${TENANT}/agent-tools/connecteur-mba`, ...h(), payload: corpsMba({ name: 'Poser Étiquette' }) });
    expect(res.statusCode).toBe(400);
  });
});

describe('la bibliothèque d’outils', () => {
  it('rend les définitions de l’espace, avec QUI s’en sert', async () => {
    const { app } = monter('ok');
    const res = await app.inject({ method: 'GET', url: `/tenants/${TENANT}/agent-tools`, ...h() });
    expect(res.statusCode).toBe(200);
    expect(res.json().outils[0].consommateurs[0].agentLabel).toBe('Support');
  });

  it('🔴 le MBA apparaît comme consommateur, SANS étiquette d’agent', async () => {
    // Il n'a ni fiche, ni modèle, ni crédit : lui inventer un libellé d'agent laisserait croire qu'on peut
    // ouvrir sa fiche. L'écran doit afficher sa clé telle quelle.
    const { app } = monter('ok');
    const res = await app.inject({ method: 'GET', url: `/tenants/${TENANT}/agent-tools`, ...h() });
    const mba = res.json().outils[0].consommateurs[1];
    expect(mba.cle).toBe('mba:1234840649713976');
    expect(mba.agentId).toBeNull();
    expect(mba.agentLabel).toBeNull();
  });

  it('🔴 supprimer une définition encore rattachée rend 409, avec un message lisible', async () => {
    // 409 et pas 500 : Cloudflare remplace le corps de toute réponse 5xx, le message n'arriverait jamais.
    const { app } = monter('rattachee');
    const res = await app.inject({ method: 'DELETE', url: `/tenants/${TENANT}/agent-tools/${OUTIL}`, ...h() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/encore utilisé/);
  });

  it('supprimer une définition libre rend 204', async () => {
    const { app, supprimes } = monter('ok');
    const res = await app.inject({ method: 'DELETE', url: `/tenants/${TENANT}/agent-tools/${OUTIL}`, ...h() });
    expect(res.statusCode).toBe(204);
    expect(supprimes).toEqual([[TENANT, OUTIL]]);
  });

  it('une définition inconnue rend 404', async () => {
    const { app } = monter('introuvable');
    const res = await app.inject({ method: 'DELETE', url: `/tenants/${TENANT}/agent-tools/${OUTIL}`, ...h() });
    expect(res.statusCode).toBe(404);
  });

  it('🔴 sans jeton, la route REFUSE : scopeTenant echoue ferme', async () => {
    // C'est LE contrôle d'isolation entre clients, pour 235 routes, et la RLS est contournée (pooler
    // superuser). Une route de ce module montée sans garde répondrait 403 partout : ce test dit que le
    // refus vient bien de l'absence de jeton, pas d'un montage bancal.
    const { app } = monter('ok');
    const res = await app.inject({ method: 'GET', url: `/tenants/${TENANT}/agent-tools` });
    expect(res.statusCode).toBe(401);
  });

  it('🔴 un identifiant qui n’est pas un UUID rend 404, sans toucher à la base', async () => {
    // Sans cette garde, Postgres lèverait sur le cast et l'erreur sortirait en 500, dont Cloudflare remplace
    // le corps : le client verrait une page d'erreur générique sur une simple faute de frappe.
    const { app, supprimes } = monter('ok');
    const res = await app.inject({ method: 'DELETE', url: `/tenants/${TENANT}/agent-tools/pas-un-uuid`, ...h() });
    expect(res.statusCode).toBe(404);
    expect(supprimes).toEqual([]);
  });
});

describe('exposer un outil au Meta Business Agent', () => {
  it('🔴 cocher RATTACHE ET ACTIVE, en un seul geste', async () => {
    // C'est la seule fois où ces deux-là se confondent. Pour un agent ils sont distincts (on ajoute, puis un
    // humain relit les mots avant d'exposer au modèle) ; le MBA n'a pas d'écran de relecture chez nous, donc
    // la case EST le consentement. En deux temps, on produirait un « rattaché mais éteint » invisible.
    const { app, gestes } = monter('ok');
    const res = await app.inject({
      method: 'PUT', url: `/tenants/${TENANT}/agent-tools/${OUTIL}/mba`, payload: { valeur: true }, ...h(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ expose: true, consommateur: 'mba:1234840649713976' });
    expect(gestes).toEqual([
      `rattache:mba:1234840649713976:${OUTIL}`,
      `active:mba:1234840649713976:${OUTIL}:true:u1`,
    ]);
  });

  it('🔴 le NUMÉRO vient du serveur, jamais du corps de la requête', async () => {
    // Le faire porter au navigateur est exactement ce qui a cassé le toggle MBA trois fois le 2026-09-10, la
    // dernière parce qu'il ne l'avait pas encore chargé au moment du clic. Un corps qui prétend en donner un
    // autre est simplement ignoré.
    const { app, gestes } = monter('ok');
    await app.inject({
      method: 'PUT', url: `/tenants/${TENANT}/agent-tools/${OUTIL}/mba`,
      payload: { valeur: true, phoneNumberId: '999999999' }, ...h(),
    });
    expect(gestes.join('|')).toContain('mba:1234840649713976');
    expect(gestes.join('|')).not.toContain('999999999');
  });

  it('décocher DÉTACHE, et n’active rien', async () => {
    const { app, gestes } = monter('ok');
    const res = await app.inject({
      method: 'PUT', url: `/tenants/${TENANT}/agent-tools/${OUTIL}/mba`, payload: { valeur: false }, ...h(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().expose).toBe(false);
    expect(gestes).toEqual([`detache:mba:1234840649713976:${OUTIL}`]);
  });

  it('🔴 sans numéro connecté, on REFUSE en le disant, on n’écrit rien', async () => {
    // Écrire une ligne pour un consommateur qui n'existe pas produirait un consentement muet : personne ne
    // le lirait, et l'écran afficherait une case cochée sans aucun effet.
    const { app, gestes } = monter('ok', null);
    const res = await app.inject({
      method: 'PUT', url: `/tenants/${TENANT}/agent-tools/${OUTIL}/mba`, payload: { valeur: true }, ...h(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/Aucun numéro/);
    expect(gestes).toEqual([]);
  });

  it('un corps sans booléen rend 400', async () => {
    const { app } = monter('ok');
    const res = await app.inject({
      method: 'PUT', url: `/tenants/${TENANT}/agent-tools/${OUTIL}/mba`, payload: { valeur: 'oui' }, ...h(),
    });
    expect(res.statusCode).toBe(400);
  });
});
