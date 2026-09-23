import { readFileSync } from 'node:fs';
import { describe, it, expect, afterEach } from 'vitest';
import { MetaPubsClient, sansPrefixeAct, retirerAncienAcces, type ClientRetrait } from '../src/meta/pubs';
import { ErreurGraph, estJetonRefuse } from '../src/meta/graph';

/**
 * LE CLIENT GRAPH DES PUBLICITÉS (lot 2, « Connecter »).
 *
 * `fetch` est remplacé ici, jamais appelé pour de vrai : un test qui touche le réseau n'est pas un test
 * unitaire (règle du dépôt, corollaire (a) du 2026-09-04).
 */

const vrai = globalThis.fetch;
afterEach(() => { globalThis.fetch = vrai; });

interface Appel { url: string; init?: RequestInit }

/** Remplace `fetch` par une table de réponses, et retient ce qui a été demandé. */
function graph(reponses: Array<{ ok?: boolean; status?: number; body: unknown }>): { appels: Appel[] } {
  const appels: Appel[] = [];
  let i = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    appels.push({ url: String(url), init });
    const r = reponses[Math.min(i++, reponses.length - 1)] ?? { body: {} };
    return { ok: r.ok !== false, status: r.status ?? 200, json: async () => r.body };
  }) as unknown as typeof fetch;
  return { appels };
}

const client = () => new MetaPubsClient('app-1', 'secret-1', 'v23.0');

function scopes(...paires: Array<[string, string[]]>): unknown {
  return { data: { granular_scopes: paires.map(([scope, target_ids]) => ({ scope, target_ids })) } };
}

describe('actifsAccordes : ce que le jeton donne VRAIMENT', () => {
  const COMPTES = { data: [{ id: 'act_111', name: 'GMC', currency: 'EUR', timezone_name: 'Europe/Paris', account_status: 1 }] };
  const PAGES = { data: [{ id: 'p1', name: 'Gerermonchantier' }] };

  it('🔴 lit /me/adaccounts et /me/accounts, JAMAIS debug_token', async () => {
    // Mesure du 2026-09-23 sur un vrai compte : un jeton d utilisateur systeme d integration rend ses
    // `granular_scopes` SANS `target_ids`, donc la lecture par le jeton rendait deux listes vides alors que
    // la connexion etait parfaite. Les points d entree dedies, eux, rendent tout.
    const { appels } = graph([{ body: COMPTES }, { body: PAGES }]);
    const actifs = await client().actifsAccordes('JETON');
    expect(appels.map((a) => a.url).join(' ')).not.toContain('debug_token');
    expect(appels[0]?.url).toContain('/me/adaccounts');
    expect(appels[1]?.url).toContain('/me/accounts');
    expect(actifs.comptesPub).toEqual([{ id: '111', nom: 'GMC', devise: 'EUR', fuseau: 'Europe/Paris', statut: 1 }]);
    expect(actifs.pages).toEqual([{ id: 'p1', nom: 'Gerermonchantier' }]);
  });

  it('⚠️ le prefixe act_ est retire a la lecture : la base et l ecran gardent la forme nue', async () => {
    graph([{ body: COMPTES }, { body: PAGES }]);
    expect((await client().actifsAccordes('JETON')).comptesPub[0]?.id).toBe('111');
  });

  it('⚠️ deux listes vides ne sont PAS une erreur : c est la route qui en fait une connexion incomplete', async () => {
    graph([{ body: {} }, { body: {} }]);
    await expect(client().actifsAccordes('JETON')).resolves.toEqual({ comptesPub: [], pages: [] });
  });

  it('🔴 un champ du mauvais TYPE ne devient pas une valeur : le safeParse refuse la liste entiere', async () => {
    graph([{ body: { data: [{ id: 'act_1', currency: 42 }] } }, { body: PAGES }]);
    expect((await client().actifsAccordes('JETON')).comptesPub).toEqual([]);
  });

  it('⚠️ le nom, la devise, le fuseau et le STATUT absents rendent null, pas une valeur inventee', async () => {
    graph([{ body: { data: [{ id: 'act_222' }] } }, { body: { data: [{ id: 'p2' }] } }]);
    const actifs = await client().actifsAccordes('JETON');
    expect(actifs.comptesPub).toEqual([{ id: '222', nom: null, devise: null, fuseau: null, statut: null }]);
    expect(actifs.pages).toEqual([{ id: 'p2', nom: null }]);
  });

  it('les deux appels portent le jeton du client', async () => {
    const { appels } = graph([{ body: COMPTES }, { body: PAGES }]);
    await client().actifsAccordes('JETON_CLIENT');
    for (const a of appels) {
      expect((a.init?.headers as Record<string, string>)?.Authorization).toBe('Bearer JETON_CLIENT');
    }
  });
});

describe('etatCompte : ce qui empeche de diffuser', () => {
  it('compte actif avec moyen de paiement : pret', async () => {
    graph([{ body: { account_status: 1, disable_reason: 0, funding_source_details: { id: '58976' } } }]);
    await expect(client().etatCompte('111', 'JETON')).resolves.toEqual({ statut: 1, raisonDesactivation: 0, moyenPaiement: true });
  });

  it('🔴 SANS moyen de paiement, `moyenPaiement` est faux : une pub se creerait sans jamais partir', async () => {
    graph([{ body: { account_status: 1, disable_reason: 0 } }]);
    expect((await client().etatCompte('111', 'JETON')).moyenPaiement).toBe(false);
  });

  it('⚠️ un moyen de paiement SANS identifiant ne compte pas : on ne devine pas', async () => {
    graph([{ body: { account_status: 1, funding_source_details: {} } }]);
    expect((await client().etatCompte('111', 'JETON')).moyenPaiement).toBe(false);
  });

  it('un compte desactive rend son statut et sa raison', async () => {
    graph([{ body: { account_status: 2, disable_reason: 3, funding_source_details: { id: 'x' } } }]);
    await expect(client().etatCompte('111', 'JETON')).resolves.toEqual({ statut: 2, raisonDesactivation: 3, moyenPaiement: true });
  });
});

/**
 * ⚠️ OÙ SONT PASSÉS LES QUATRE CAS DE `pageLieeAuCompte`, plutôt que de les faire disparaître en silence.
 *
 * Ils éprouvaient les trois verdicts d'un appel qui N'EXISTE PLUS : mesuré le 2026-09-23 sur le compte
 * réel, aucune API de Meta n'expose la liaison Page / numéro (dix champs essayés, détail dans
 * `src/meta/pubs.ts`). Le quatrième cas disait lui-même « le champ reste à mesurer sur un vrai compte » :
 * la mesure a tranché, et l'appel était condamné à un 400 à chaque choix.
 *
 * Il n'y a donc PAS de remplaçant à écrire côté client : on ne teste pas une méthode qu'on retire. Ce qui
 * reste à garder, c'est qu'on ne la réécrive pas sans remesurer, et c'est le cas ci-dessous. Le
 * comportement VISIBLE (l'écran envoie chez Meta au lieu de prétendre savoir) est tenu par
 * `web/e2e/publicites-connexion.spec.ts`.
 */
describe("la liaison Page / numéro ne se redemande pas à Meta sans l'avoir remesurée", () => {
  it('🔴 aucun appel ne demande `connected_whatsapp_business_account` : ce champ n existe pas', () => {
    const source = readFileSync(new URL('../src/meta/pubs.ts', import.meta.url), 'utf8');
    // Si Meta l'expose un jour, ce test se retire EN MÊME TEMPS que l'appel est réécrit, et après une
    // nouvelle mesure sur un compte réel. C'est précisément ce qu'il demande : remesurer d'abord.
    // ⚠️ Le commentaire qui EXPLIQUE la mesure nomme le champ lui aussi : on ne cherche donc que les
    // lignes de code, sinon ce test échouerait sur sa propre justification.
    const code = source.split(/\r?\n/).filter((l) => {
      const t = l.trimStart();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
    });
    expect(code.join(' ')).not.toContain('connected_whatsapp_business_account');
  });
});

/**
 * 🔴 LE RETRAIT DE L'ANCIEN ACCÈS S'EXÉCUTE POUR DE VRAI, CONTRE UN FAUX CLIENT.
 *
 * Cette décision a vécu dans un `if` du câblage, gardée par un test qui lisait le TEXTE de ce `if`.
 * Deux relectures à froid l'ont mesuré, et les deux fois la garde a été prise en défaut : la première
 * écriture laissait passer la condition NIÉE, la seconde laissait passer le `!` RETIRÉ et les corps
 * ÉCHANGÉS. Trois orthographes du MÊME bug, celui qui désarme le jeton qu'on vient de déposer et fait
 * répondre 200 sur une connexion morte. **Un test de source ne sait pas juger une sémantique.**
 *
 * Ici les cinq issues sont exercées par le vrai code, et ce qui est asserté est CE QUI PART chez Meta :
 * la liste des jetons révoqués. Une mutation qui inverse la décision la remplit quand elle doit rester
 * vide, et aucune réécriture correcte ne peut faire tomber ces cas.
 */
describe('retirerAncienAcces : on ne retire que sur une différence CONSTATÉE', () => {
  const faux = (identites: Record<string, string | null>, refuse = false) => {
    const revoques: string[] = [];
    const client: ClientRetrait = {
      identite: async (j) => identites[j] ?? null,
      revoquerAcces: async (j) => {
        revoques.push(j);
        if (refuse) throw new Error('Meta refuse');
      },
    };
    return { client, revoques };
  };

  it('sans ancien jeton, il n y a rien à retirer', async () => {
    const { client, revoques } = faux({});
    await expect(retirerAncienAcces(client, null, 'NEUF')).resolves.toBe('aucun');
    expect(revoques).toEqual([]);
  });

  it("🔴 deux entités DIFFÉRENTES : on retire l'ancien, et lui seul", async () => {
    const { client, revoques } = faux({ ANCIEN: 'sys-1', NEUF: 'sys-2' });
    await expect(retirerAncienAcces(client, 'ANCIEN', 'NEUF')).resolves.toBe('retire');
    expect(revoques).toEqual(['ANCIEN']);
  });

  it('🔴 la MÊME entité : AUCUN appel de retrait ne part, sinon on désarme le neuf', async () => {
    const { client, revoques } = faux({ ANCIEN: 'sys-1', NEUF: 'sys-1' });
    await expect(retirerAncienAcces(client, 'ANCIEN', 'NEUF')).resolves.toBe('meme_entite');
    // C'est CE QUI PART qui compte : un `revoques` non vide ici est le bug, quelle que soit la valeur rendue.
    expect(revoques).toEqual([]);
  });

  it('🔴 une identité INCONNUE vaut refus, des DEUX côtés, et rien ne part', async () => {
    const cas: Array<Record<string, string | null>> = [{ NEUF: 'sys-2' }, { ANCIEN: 'sys-1' }, {}];
    for (const identites of cas) {
      const { client, revoques } = faux(identites);
      await expect(retirerAncienAcces(client, 'ANCIEN', 'NEUF')).resolves.toBe('indetermine');
      expect(revoques).toEqual([]);
    }
  });

  it('⚠️ un refus de Meta ne lève pas, il se DIT : `echec`, pas `retire`', async () => {
    const { client, revoques } = faux({ ANCIEN: 'sys-1', NEUF: 'sys-2' }, true);
    await expect(retirerAncienAcces(client, 'ANCIEN', 'NEUF')).resolves.toBe('echec');
    expect(revoques).toEqual(['ANCIEN']);
  });
});

describe('sansPrefixeAct', () => {
  it('retire act_ une seule fois, et laisse un identifiant nu tel quel', () => {
    expect(sansPrefixeAct('act_123')).toBe('123');
    expect(sansPrefixeAct('123')).toBe('123');
  });
});

describe('revoquerAcces : retirer nos acces PUBLICITAIRES, et eux seuls', () => {
  it('🔴 ne desautorise JAMAIS l application en entier : chaque permission est nommee', async () => {
    // `DELETE /me/permissions` sans argument retire TOUTES les permissions de l application, or c est la
    // MEME application que l inscription WhatsApp : un clic sur « Deconnecter » de l ecran Publicites
    // aurait pu faire taire le numero du client.
    const { appels } = graph([{ body: { success: true } }]);
    await client().revoquerAcces('JETON_CLIENT');
    const urls = appels.map((a) => a.url);
    expect(urls.some((u) => /\/me\/permissions$/.test(u.split('?')[0] ?? ''))).toBe(false);
    expect(urls.some((u) => u.includes('/me/permissions/ads_management'))).toBe(true);
    expect(urls.some((u) => u.includes('/me/permissions/ads_read'))).toBe(true);
    expect(urls.some((u) => u.includes('/me/permissions/pages_manage_ads'))).toBe(true);
    for (const a of appels) {
      expect(a.init?.method).toBe('DELETE');
      expect((a.init?.headers as Record<string, string>)?.Authorization).toBe('Bearer JETON_CLIENT');
    }
  });

  it('🔴 les permissions PARTAGEES avec l inscription WhatsApp ne sont PAS touchees', async () => {
    // On ne peut pas savoir si `business_management` sert ailleurs dans la meme application sans la retirer
    // pour voir. On referme la porte qu on a ouverte, pas celle du voisin.
    const { appels } = graph([{ body: { success: true } }]);
    await client().revoquerAcces('JETON');
    const urls = appels.map((a) => a.url).join(' ');
    expect(urls).not.toContain('business_management');
    expect(urls).not.toContain('pages_show_list');
    expect(urls).not.toContain('pages_read_engagement');
  });

  it('🔴 un retrait PARTIEL leve quand meme, et NOMME ce qui a resiste', async () => {
    // Deux sur trois retirees n est pas un succes : le silence laisserait croire que tout est ferme,
    // alors qu un acces vit encore chez Meta et que nous effacons notre seule copie juste apres.
    const { appels } = graph([
      { body: { success: true } },
      { ok: false, status: 400, body: { error: { message: 'refus cible', code: 200 } } },
      { body: { success: true } },
    ]);
    await expect(client().revoquerAcces('JETON')).rejects.toThrow(/ads_read/);
    // et les TROIS ont bien ete tentees : un refus n arrete pas les suivantes
    expect(appels).toHaveLength(3);
  });

  it('⚠️ un refus de Meta LEVE : c est l appelant qui decide si la deconnexion continue', async () => {
    graph([{ ok: false, status: 400, body: { error: { message: 'non supporte', code: 100 } } }]);
    await expect(client().revoquerAcces('JETON')).rejects.toThrow('Graph 400 (#100) : non supporte');
  });
});

describe('estJetonRefuse : un jeton mort, pas une panne', () => {
  it('retient le jeton expiré (190), la session fermée (102) et le 401', () => {
    expect(estJetonRefuse(new ErreurGraph(400, 190, 'Graph 400 (#190) : token expiré'))).toBe(true);
    expect(estJetonRefuse(new ErreurGraph(400, 102, 'Graph 400 (#102) : session'))).toBe(true);
    expect(estJetonRefuse(new ErreurGraph(401, null, 'Graph 401 : non autorisé'))).toBe(true);
  });

  it('🔴 le code 10 reste DEHORS : une action refusée n est pas un jeton mort', () => {
    // Le retenir afficherait « reconnectez-vous » à un client dont la connexion est valide, pour un appel
    // qui restera refusé après la reconnexion.
    expect(estJetonRefuse(new ErreurGraph(403, 10, 'Graph 403 (#10) : permission'))).toBe(false);
  });

  it('⚠️ une panne ordinaire n est pas un refus : ni un 500 de Meta, ni une erreur réseau', () => {
    expect(estJetonRefuse(new ErreurGraph(500, 1, 'Graph 500 (#1) : erreur interne'))).toBe(false);
    expect(estJetonRefuse(new Error('fetch failed'))).toBe(false);
  });

  it('⚠️ le MESSAGE de l erreur Graph n a pas changé d un caractère : c est une sous-classe, pas un format neuf', async () => {
    graph([{ ok: false, status: 400, body: { error: { message: 'champ inconnu', code: 100 } } }]);
    await expect(client().actifsAccordes('JETON')).rejects.toThrow('Graph 400 (#100) : champ inconnu');
  });
});
