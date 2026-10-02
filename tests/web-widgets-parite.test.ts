import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { registerWidgets, type WidgetsRouteDeps } from '../src/http/widgets';
import {
  COULEUR_PAR_DEFAUT as COULEUR_SERVEUR, LIMITE_WIDGETS_PAR_ESPACE, MAX_LIBELLE_WIDGET as LIBELLE_SERVEUR,
  MAX_NOM_WIDGET as NOM_SERVEUR, MAX_PHRASE_WIDGET as PHRASE_SERVEUR, POSITIONS_WIDGET as POSITIONS_SERVEUR,
} from '../src/widgets/gestion';
import * as ecran from '../web/lib/widgets';

/**
 * L'ÉCRAN DES WIDGETS ET LE SERVEUR, DES DEUX CÔTÉS (lot 4 du widget).
 *
 * `web/` n'importe jamais `src/` : les bornes et les chemins sont RECOPIÉS dans `web/lib/widgets.ts`. Une recopie non
 * tenue dérive, et chacune de ses deux dérives a un symptôme qu'aucun compilateur ne voit : une borne qui diverge
 * fait promettre à l'écran ce que le serveur refuse ; un chemin qui diverge rend un 404 découvert à l'écran (leçon de
 * Channels Me, `/connexion` contre `/connection`).
 */

// Le socle HTTP de la console est remplacé (`vi.mock` passe avant les imports) : ce test ne touche aucun réseau, il
// note ce que `request` reçoit.
const appels = vi.hoisted((): Array<{ path: string; method: string }> => []);
vi.mock('../web/lib/http', () => ({
  request: (path: string, init?: RequestInit) => {
    appels.push({ path, method: (init?.method ?? 'GET').toUpperCase() });
    return Promise.resolve({});
  },
}));

describe('les bornes de l’écran sont celles du serveur', () => {
  it('la limite, les longueurs, la couleur par défaut et les quatre coins', () => {
    expect(ecran.LIMITE_WIDGETS).toBe(LIMITE_WIDGETS_PAR_ESPACE);
    expect(ecran.MAX_NOM_WIDGET).toBe(NOM_SERVEUR);
    expect(ecran.MAX_PHRASE_WIDGET).toBe(PHRASE_SERVEUR);
    expect(ecran.MAX_LIBELLE_WIDGET).toBe(LIBELLE_SERVEUR);
    expect(ecran.COULEUR_PAR_DEFAUT).toBe(COULEUR_SERVEUR);
    expect([...ecran.POSITIONS_WIDGET]).toEqual([...POSITIONS_SERVEUR]);
  });
});

describe('🔴 chaque appel de l’écran vise une route que le serveur monte', () => {
  it('méthode et chemin, un par un', async () => {
    const TENANT = 'tenant-x';
    const ID = 'widget-y';
    const saisie = {
      nom: 'n', phrase: 'p', devenir: null, workflowId: null, couleur: '#25d366', position: 'bas_droite' as const,
      libelle: null, avatarUrl: null, actif: true, maxParHeure: null,
    };
    appels.length = 0;
    await ecran.listerWidgets(TENANT);
    await ecran.creerWidget(TENANT, saisie);
    await ecran.modifierWidget(TENANT, ID, { actif: false });
    await ecran.supprimerWidget(TENANT, ID);
    const demandes = appels.map((a) => `${a.method} ${a.path.replace(TENANT, ':tenantId').replace(ID, ':id')}`);

    const app = Fastify({ logger: false });
    const montees: string[] = [];
    app.addHook('onRoute', (r) => {
      for (const m of [r.method].flat()) if (m !== 'HEAD') montees.push(`${m} ${r.path}`);
    });
    // Rien n'est appelé : on ne fait que monter, pour lire les adresses.
    registerWidgets(app, {} as WidgetsRouteDeps, async () => {});
    await app.ready();
    await app.close();

    expect(demandes).toHaveLength(4);
    expect([...demandes].sort()).toEqual([...montees].sort());
  });
});
