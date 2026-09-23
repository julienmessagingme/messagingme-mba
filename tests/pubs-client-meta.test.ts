import { describe, it, expect, afterEach } from 'vitest';
import { MetaPubsClient, sansPrefixeAct } from '../src/meta/pubs';
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

describe('actifsAccordes : ce que le jeton donne', () => {
  it('rend les comptes publicitaires et les Pages, et retire le prefixe act_', async () => {
    graph([
      { body: scopes(['ads_management', ['act_111', '222']]) },
      { body: scopes(['pages_show_list', ['p1', 'p2']]) },
    ]);
    await expect(client().actifsAccordes('JETON')).resolves.toEqual({ comptesPub: ['111', '222'], pages: ['p1', 'p2'] });
  });

  it('⚠️ deux listes vides ne sont PAS une erreur : c est la route qui en fait une connexion incomplete', async () => {
    graph([{ body: { data: { granular_scopes: null } } }]);
    await expect(client().actifsAccordes('JETON')).resolves.toEqual({ comptesPub: [], pages: [] });
  });

  it('inspecte le jeton du client AVEC le jeton d application, jamais avec celui du client', async () => {
    const { appels } = graph([{ body: scopes(['ads_management', ['1']]) }, { body: scopes(['pages_show_list', []]) }]);
    await client().actifsAccordes('JETON_CLIENT');
    expect(appels[0]?.url).toContain('input_token=JETON_CLIENT');
    expect(appels[0]?.url).toContain(`access_token=${encodeURIComponent('app-1|secret-1')}`);
  });
});

describe('infosCompte : devise et fuseau', () => {
  it('lit le nom, la devise et le fuseau, et remet le prefixe act_ dans l adresse', async () => {
    const { appels } = graph([{ body: { name: 'MessagingMe', currency: 'EUR', timezone_name: 'Europe/Paris' } }]);
    await expect(client().infosCompte('act_111', 'JETON')).resolves.toEqual({
      nom: 'MessagingMe', devise: 'EUR', fuseau: 'Europe/Paris',
    });
    expect(appels[0]?.url).toContain('/act_111?');
  });

  it('🔴 une reponse qui ne porte pas ces champs rend trois nulls, jamais une valeur inventee', async () => {
    graph([{ body: { id: 'act_111' } }]);
    await expect(client().infosCompte('111', 'JETON')).resolves.toEqual({ nom: null, devise: null, fuseau: null });
  });

  it('🔴 un champ du mauvais TYPE ne passe pas pour une valeur : le safeParse le refuse', async () => {
    graph([{ body: { name: 'MessagingMe', currency: 42, timezone_name: 'Europe/Paris' } }]);
    await expect(client().infosCompte('111', 'JETON')).resolves.toEqual({ nom: null, devise: null, fuseau: null });
  });
});

describe('pageLieeAuCompte : trois verdicts, pas deux', () => {
  it('oui quand la Page porte le compte WhatsApp de l espace', async () => {
    graph([{ body: { connected_whatsapp_business_account: { id: 'WABA_1' } } }]);
    await expect(client().pageLieeAuCompte('p1', 'WABA_1', 'JETON')).resolves.toBe('oui');
  });

  it('non quand elle en porte un AUTRE : la liaison existe, mais pas avec nous', async () => {
    graph([{ body: { connected_whatsapp_business_account: { id: 'WABA_VOISIN' } } }]);
    await expect(client().pageLieeAuCompte('p1', 'WABA_1', 'JETON')).resolves.toBe('non');
  });

  it('🔴 inconnu quand le champ manque : une ignorance ne se dit pas « non liee »', async () => {
    graph([{ body: { id: 'p1' } }]);
    await expect(client().pageLieeAuCompte('p1', 'WABA_1', 'JETON')).resolves.toBe('inconnu');
  });

  it('🔴 inconnu quand Graph REFUSE l appel, et sans lever : le champ reste a mesurer sur un vrai compte', async () => {
    graph([{ ok: false, status: 400, body: { error: { message: 'champ inconnu', code: 100 } } }]);
    await expect(client().pageLieeAuCompte('p1', 'WABA_1', 'JETON')).resolves.toBe('inconnu');
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
    await expect(client().infosCompte('111', 'JETON')).rejects.toThrow('Graph 400 (#100) : champ inconnu');
  });
});
