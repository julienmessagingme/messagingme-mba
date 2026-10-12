import { describe, expect, it, vi } from 'vitest';
import { creerAccesPublicitaire } from '../src/pubs/acces-publicitaire';
import type { GestesConnexionPub } from '../src/pubs/connexion';

describe('accès publicitaire', () => {
  it('appelle Meta avec le compte et le jeton fournis par la connexion de cet espace', async () => {
    const audiences = vi.fn(async () => ({ audiences: [], tronquee: false }));
    const meta = {
      jetonDePage: vi.fn(async () => null),
      televerserImage: vi.fn(async () => 'hash'),
      etatVideo: vi.fn(async () => ({ etat: 'prete' as const, progression: 100 })),
      vignetteVideo: vi.fn(async () => 'hash'),
      etatAudiences: vi.fn(async () => new Map()),
      creerCampagne: vi.fn(async () => 'campagne'),
      creerEnsemble: vi.fn(async () => 'ensemble'),
      creerCrea: vi.fn(async () => 'crea'),
      creerPub: vi.fn(async () => 'pub'),
      supprimerCampagne: vi.fn(async () => undefined),
      demarrerDepotVideo: vi.fn(async () => ({ videoId: 'video', sessionId: 'session', debut: 0, fin: 0 })),
      transfererMorceauVideo: vi.fn(async () => ({ debut: 0, fin: 0 })),
      terminerDepotVideo: vi.fn(async () => undefined),
      audiences,
      changerStatut: vi.fn(async () => undefined),
    };
    const publicites = {
      lire: vi.fn(async () => null),
      comptesDeLaCampagne: vi.fn(async () => ({
        depense: null, clics: null, impressions: null, couverture: null,
        leads: 0, qualifies: 0, nonPrisEnCharge: 0,
      })),
      ouvrir: vi.fn(async () => 'id'),
      noterIds: vi.fn(async () => undefined),
      marquerEtat: vi.fn(async () => undefined),
      memoriserPub: vi.fn(async () => undefined),
      creerAutomation: vi.fn(async () => 'automation'),
      supprimerAutomation: vi.fn(async () => undefined),
      allumerAutomation: vi.fn(async () => true),
      noterStatutMeta: vi.fn(async () => undefined),
    };
    const appelerMeta = async <T>(appel: (jeton: string) => Promise<T>): Promise<T> => appel('jeton-espace');
    const connexion: Pick<GestesConnexionPub, 'avecConfiguration' | 'avecJeton'> = {
      avecConfiguration: async (_tenantId, action) => action({
        comptePubId: 'act_123', pageId: 'page_456', appelerMeta,
      }),
      avecJeton: async (_tenantId, action) => action(appelerMeta),
    };
    const acces = creerAccesPublicitaire({
      connexion, meta, publicites,
      numeroWhatsApp: async () => '+33 6 12 34 56 78',
    });

    await acces.audiences('espace-1');

    expect(audiences).toHaveBeenCalledWith('act_123', 'jeton-espace');
  });
});
