import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { registerWidgets, type WidgetsRouteDeps } from '../src/http/widgets';
import * as ecran from '../web/lib/widgets';

/**
 * L'ÉCRAN DES WIDGETS ET LE SERVEUR, DES DEUX CÔTÉS (lot 4 du widget).
 *
 * Les bornes sont partagées (`web/lib/partage/widgets.ts`, lot D de l'audit de structure du 2026-10-26) ; les CHEMINS
 * restent écrits dans `web/lib/widgets.ts`. Un chemin qui diverge rend un 404 découvert à l'écran, qu'aucun compilateur
 * ne voit (leçon de Channels Me, `/connexion` contre `/connection`).
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
