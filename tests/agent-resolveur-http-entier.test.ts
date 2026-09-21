import { describe, it, expect } from 'vitest';
import { creerAppelConnecteur, type AppelConnecteur } from '../src/agent/resolvers/http';
import type { SourceAppel } from '../src/agent/sources';
import type { RequeteConnecteur } from '../src/agent/requetes';

/**
 * La lecture « entier » : le mode du relais du Meta Business Agent (spec 2026-09-21-relais-mba-design.md).
 *
 * 🔴 ARBITRAGE DE JULIEN DU 2026-09-21 : l'agent de Meta reçoit la réponse ENTIÈRE du système du client. Un
 * modèle qui ne voit rien risque de conclure à un échec et de transférer à un humain. Les échecs, eux,
 * gardent le message SÛR du point de passage, jamais le corps brut d'une erreur.
 */
const SOURCE: SourceAppel = {
  id: 'src1', kind: 'http', baseUrl: 'https://api.client.fr', authKind: 'bearer', authHeaderName: null,
  authSecret: 'S', status: 'active',
};
const REQUETE: RequeteConnecteur = {
  id: 'rq1', tenantId: 't1', sourceId: 'src1', label: 'Ajouter une étiquette', methode: 'POST',
  chemin: '/subscriber/add-tag', parametres: [], entetes: [],
  corps: { mode: 'json', gabarit: '{"user_ns":"{{user}}"}' },
  variables: [{ nom: 'user', type: 'string', origine: { type: 'modele' }, requis: true }],
  outputPaths: [], valeursTest: {}, outils: 1, updatedAt: '2026-09-21T00:00:00.000Z',
};

function appelAvec(reponse: { status: number; body: string | null }) {
  const appel = creerAppelConnecteur({
    sources: { pourAppel: async () => SOURCE, marquerEpreuve: async () => {} },
    requetes: { parId: async () => REQUETE },
    fetchImpl: (async () => new Response(reponse.body, { status: reponse.status })) as unknown as typeof fetch,
    verifierResolution: async () => ({ ok: true }),
  });
  const p: AppelConnecteur = {
    tenantId: 't1', waId: '33600', contact: { nom: 'J', tags: [], champs: {} }, requestId: 'rq1',
    maxBytes: 16_384, args: { user: 'u1' }, signal: AbortSignal.timeout(5_000), journal: null,
    lecture: { nature: 'entier' },
  };
  return appel(p);
}

describe('lecture « entier » : la réponse du client, telle quelle', () => {
  it('🔴 rend le JSON ENTIER, même sans aucun champ déclaré', async () => {
    // Un `integre` sans champ est REFUSÉ ; `entier` n'a rien à déclarer.
    const r = await appelAvec({ status: 200, body: '{"success":true,"data":{"tag":"vip"}}' });
    expect(r.ok).not.toBe(false);
    expect(r.contenu).toEqual({ reponse: { success: true, data: { tag: 'vip' } } });
    expect(r.httpStatus).toBe(200);
  });

  it('un corps vide (204) rend `null`, pas une erreur', async () => {
    const r = await appelAvec({ status: 204, body: null });
    expect(r.ok).not.toBe(false);
    expect(r.contenu).toEqual({ reponse: null });
  });

  it('un corps qui n’est pas du JSON est rendu en TEXTE', async () => {
    const r = await appelAvec({ status: 200, body: 'OK' });
    expect(r.contenu).toEqual({ reponse: 'OK' });
  });

  it('🔴 un 4xx du client garde le message SÛR, jamais son corps brut', async () => {
    const r = await appelAvec({ status: 422, body: '{"trace":"/srv/app/secret.php"}' });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.contenu)).not.toContain('secret.php');
  });
});
