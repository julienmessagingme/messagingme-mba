import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  preparerCreationSource,
  preparerPatchSource,
} from '../src/agent/source-configuration';

describe('contrat commun des sources d outils', () => {
  it.each([
    'http://api.client.fr/v1',
    'https://localhost/v1',
    'https://127.0.0.1/v1',
    'https://169.254.169.254/latest',
    'https://mba-api.internal/v1',
    'pas une url',
  ])('refuse l adresse non publique ou non HTTPS %s', (baseUrl) => {
    expect(preparerCreationSource({ baseUrl, authKind: 'none' })).toMatchObject({
      ok: false,
      motif: 'adresse_refusee',
      erreur: 'adresse refusée : elle doit être publique et en HTTPS',
    });
  });

  it('rend le même contrat d authentification aux connecteurs HTTP et MCP', () => {
    expect(preparerCreationSource({
      baseUrl: 'https://api.client.fr/v1', authKind: 'bearer',
    })).toMatchObject({ ok: false, motif: 'secret_requis' });

    expect(preparerCreationSource({
      baseUrl: 'https://api.client.fr/v1', authKind: 'header', authSecret: 'jeton',
    })).toMatchObject({ ok: false, motif: 'entete_requis' });

    expect(preparerCreationSource({
      baseUrl: 'https://api.client.fr/v1', authKind: 'header',
      authHeaderName: 'X-Api-Key', authSecret: 'jeton',
    })).toEqual({ ok: true, hote: 'api.client.fr' });
  });

  it('calcule le PATCH sur l état effectif sans exiger de renvoyer le secret', () => {
    const actuelle = {
      baseUrl: 'https://api.client.fr/v1',
      authKind: 'none' as const,
      authHeaderName: null,
      aAuthentification: true,
    };

    expect(preparerPatchSource(actuelle, { authKind: 'bearer' })).toEqual({
      ok: true,
      authKind: 'bearer',
      adresseChangee: false,
    });

    expect(preparerPatchSource({ ...actuelle, aAuthentification: false }, { authKind: 'bearer' }))
      .toMatchObject({ ok: false, motif: 'secret_requis' });
  });

  it('calcule l en-tête effectif et les seuls faits utiles au journal', () => {
    const actuelle = {
      baseUrl: 'https://api.client.fr/v1',
      authKind: 'header' as const,
      authHeaderName: 'X-Api-Key',
      aAuthentification: true,
    };

    expect(preparerPatchSource(actuelle, { authHeaderName: null })).toMatchObject({
      ok: false,
      motif: 'entete_requis',
    });
    expect(preparerPatchSource(actuelle, { baseUrl: 'https://erp.client.fr/v2' })).toEqual({
      ok: true,
      authKind: 'header',
      adresseChangee: true,
      hote: 'erp.client.fr',
    });
  });

  it('interdit aux deux adaptateurs HTTP de dépendre l un de l autre', () => {
    const connecteurs = readFileSync('src/http/agent-sources.ts', 'utf8');
    const mcp = readFileSync('src/http/agent-mcp.ts', 'utf8');

    expect(connecteurs).toContain("from '../agent/source-configuration'");
    expect(mcp).toContain("from '../agent/source-configuration'");
    expect(mcp).not.toContain("from './agent-sources'");
  });
});
