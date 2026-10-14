import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { lireHubspotPortal, HubspotServiceError, type ConnectorDeps } from '../src/crm/hubspot-service';
import type { HttpResponse } from '../src/meta/http';

/**
 * LE PORTAIL HUBSPOT D'UN ESPACE EST LU PAR LE CONNECTEUR (lot 1 de la bascule Scaleway). On le lisait en
 * cross-schéma dans `mmhs`, dans la même base ; une fois ce schéma sur sa propre base, la lecture rendrait `42P01`,
 * que les consommateurs traduisaient en « aucun portail relié », et l'interrupteur aurait laissé éteindre HubSpot
 * par-dessus un portail relié. Le contrat : « pas relié » seulement si aucun connecteur n'est configuré ou si le
 * connecteur le dit ; toute panne est une ERREUR.
 */
function connecteur(reponses: HttpResponse[]) {
  const appels: Array<{ url: string; body: unknown; signature: string | undefined }> = [];
  const deps: ConnectorDeps = {
    baseUrl: 'http://mm-hubspot-api:8096',
    secret: 'secret-du-canal',
    transport: {
      post: async (url, body, headers) => {
        appels.push({ url, body, signature: headers['x-mm-service-signature'] });
        return reponses.shift() ?? { status: 500, json: null };
      },
    },
  };
  return { deps, appels };
}

describe('lireHubspotPortal : le portail lu par le connecteur', () => {
  it('aucun connecteur configuré : « pas relié », sans aucun appel', async () => {
    expect(await lireHubspotPortal(null, 't1')).toEqual({ connected: false });
  });

  it('🔴 un appel SIGNÉ à POST /service/portal, avec le tenant, et la réponse rendue telle quelle', async () => {
    const { deps, appels } = connecteur([{ status: 200, json: { connected: true, hubId: '139615673', hubDomain: 'acme.hubspot.com', listsScopeGranted: true } }]);
    expect(await lireHubspotPortal(deps, 't1')).toEqual({ connected: true, hubId: '139615673', hubDomain: 'acme.hubspot.com', listsScopeGranted: true });
    expect(appels).toHaveLength(1);
    expect(appels[0]!.url).toBe('http://mm-hubspot-api:8096/service/portal');
    expect(appels[0]!.body).toEqual({ tenantId: 't1' });
    expect(appels[0]!.signature).toMatch(/^v1=/);
  });

  it('le connecteur dit « pas relié » : « pas relié »', async () => {
    const { deps } = connecteur([{ status: 200, json: { connected: false } }]);
    expect(await lireHubspotPortal(deps, 't1')).toEqual({ connected: false });
  });

  it('🔴 un connecteur pas encore à jour (404) est une ERREUR, jamais « pas relié »', async () => {
    const { deps } = connecteur([{ status: 404, json: { message: 'Route POST:/service/portal not found' } }]);
    await expect(lireHubspotPortal(deps, 't1')).rejects.toBeInstanceOf(HubspotServiceError);
  });

  it('🔴 une signature refusée (401) est une ERREUR', async () => {
    const { deps } = connecteur([{ status: 401, json: { error: 'invalid signature' } }]);
    await expect(lireHubspotPortal(deps, 't1')).rejects.toBeInstanceOf(HubspotServiceError);
  });

  it('🔴 une réponse d’une autre forme est une ERREUR (validée par Zod, jamais devinée)', async () => {
    for (const json of [{ connected: 'oui' }, { connected: true }, { connected: true, hubId: '', hubDomain: null, listsScopeGranted: true }, null]) {
      const { deps } = connecteur([{ status: 200, json }]);
      await expect(lireHubspotPortal(deps, 't1'), JSON.stringify(json)).rejects.toMatchObject({ code: 'reponse_invalide' });
    }
  });

  it('🔴 un connecteur en panne (5xx répétés) est une ERREUR, après les reprises', async () => {
    const panne = Array.from({ length: 6 }, () => ({ status: 503, json: null }));
    const { deps, appels } = connecteur(panne);
    await expect(lireHubspotPortal(deps, 't1')).rejects.toBeInstanceOf(HubspotServiceError);
    expect(appels.length).toBeGreaterThan(1);
  }, 15_000);
});

describe('plus aucune lecture du schéma du connecteur dans le code de Messaging Me', () => {
  const fichiers = (dossier: string): string[] => readdirSync(dossier).flatMap((nom) => {
    const chemin = join(dossier, nom);
    return statSync(chemin).isDirectory() ? fichiers(chemin) : chemin.endsWith('.ts') ? [chemin] : [];
  });

  it('🔴 aucun `from mmhs.` ni `join mmhs.` dans src/ : une fois `mmhs` sur sa propre base, ce serait `42P01`', () => {
    const lus = fichiers(resolve(__dirname, '..', 'src')).filter((f) => /\b(from|join)\s+mmhs\./i.test(readFileSync(f, 'utf8')));
    expect(lus).toEqual([]);
  });
});
