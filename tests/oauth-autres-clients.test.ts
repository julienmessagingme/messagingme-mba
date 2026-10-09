import { describe, it, expect } from 'vitest';
import {
  adresseDeRetourAcceptee, adresseDeRetourPermise, estAdresseDeFiche, estClientEnregistre, type ClientResolu,
} from '../src/oauth/clients';
import { CACHE_ECHEC_MS, CACHE_FICHE_MS, PLAFOND_FICHE_OCTETS, creerLecteurDeFiches, nomAffichable } from '../src/oauth/fiche-client';
import { nouvelIdentifiantClient } from '../src/oauth/clients.pg';
import { formeDeClient } from '../src/oauth/resolution';

/**
 * LOT 15 : LES AUTRES CLIENTS MCP, ce qui se vérifie sans serveur ni réseau (spec `2026-10-09-oauth-autres-clients-design.md`).
 * La politique des adresses de retour (décision de Julien : https ou boucle locale), la forme des identifiants, et la
 * fiche d'identité récupérée avec nos gardes. Les routes sont dans `tests/http-oauth.test.ts`.
 */
describe('la politique des adresses de retour d’un client non épinglé', () => {
  it('accepte https sur tout hôte et la boucle locale sur tout port', () => {
    for (const ok of [
      'https://chatgpt.com/connector_platform_oauth_redirect',
      'https://www.cursor.com/agents/mcp/oauth/callback',
      'https://app.exemple.fr',
      'http://localhost:8787/callback',
      'http://127.0.0.1:33418/',
      'http://localhost/callback',
    ]) expect(adresseDeRetourPermise(ok), ok).toBe(true);
  });

  it('🔴 refuse les schémas d’application, le http distant, et toute forme ambiguë', () => {
    for (const non of [
      'cursor://anysphere.cursor-mcp/oauth/callback',
      'vscode://vscode.github-authentication/did-authenticate',
      'http://evil.test/callback',
      'http://[::1]:8080/callback',
      'https://localhost@evil.test/callback',
      'https://chatgpt.com/cb?x=1',
      'https://chatgpt.com/cb#f',
      'https://CHATGPT.com/cb',
      'javascript:alert(1)',
      'pas une adresse',
      `https://exemple.fr/${'a'.repeat(2000)}`,
    ]) expect(adresseDeRetourPermise(non), non).toBe(false);
  });

  it('une boucle locale sans barre finale vaut sa forme à barre, sur tout port', () => {
    expect(adresseDeRetourPermise('http://127.0.0.1:8787')).toBe(true);
    const c: ClientResolu = { id: 'mcl_x', nom: 'X', adressesDeRetour: ['http://127.0.0.1:8787'], marque: 'declaree' };
    expect(adresseDeRetourAcceptee(c, 'http://127.0.0.1:9999/')).toBe(true);
    expect(adresseDeRetourAcceptee(c, 'http://127.0.0.1:9999')).toBe(true);
  });

  it('un client déclaré avec un port de boucle locale reçoit son code sur un autre port, jamais sur un autre chemin', () => {
    const c: ClientResolu = { id: 'mcl_x', nom: 'VS Code', adressesDeRetour: ['http://127.0.0.1:33418/'], marque: 'declaree' };
    expect(adresseDeRetourAcceptee(c, 'http://127.0.0.1:51234/')).toBe(true);
    expect(adresseDeRetourAcceptee(c, 'http://127.0.0.1:51234/autre')).toBe(false);
    expect(adresseDeRetourAcceptee(c, 'http://localhost:51234/')).toBe(false);
  });
});

describe('la forme des identifiants', () => {
  it('un identifiant enregistré : mcl_ et 32 caractères, tiré au hasard', () => {
    const a = nouvelIdentifiantClient();
    expect(a).toMatch(/^mcl_[A-Za-z0-9]{32}$/);
    expect(nouvelIdentifiantClient()).not.toBe(a);
    expect(estClientEnregistre(a)).toBe(true);
    expect(estClientEnregistre('mcl_court')).toBe(false);
  });

  it('une fiche : https, un chemin, sans requête ni fragment ; un épinglé n’en est pas une', () => {
    expect(estAdresseDeFiche('https://chatgpt.com/oauth/abc/client.json')).toBe(true);
    expect(estAdresseDeFiche('https://chatgpt.com/')).toBe(false);
    expect(estAdresseDeFiche('https://chatgpt.com/x?y=1')).toBe(false);
    expect(estAdresseDeFiche('http://chatgpt.com/x')).toBe(false);
    expect(estAdresseDeFiche('https://claude.ai/oauth/claude-code-client-metadata')).toBe(false);
    expect(formeDeClient('https://claude.ai/oauth/claude-code-client-metadata')).toBe(true);
    expect(formeDeClient('pas-un-client')).toBe(false);
  });
});

describe('🔴 la fiche d’identité, récupérée avec nos gardes', () => {
  const ID = 'https://chatgpt.com/oauth/abc/client.json';
  const ficheValide = { client_id: ID, client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] };

  function monter(o: { corps?: string; statut?: number; verdict?: boolean; jeter?: Error } = {}) {
    const appels: Array<{ url: string; init: RequestInit | undefined }> = [];
    let t = 1_000_000;
    const lecteur = creerLecteurDeFiches({
      fetch: (async (url: string, init?: RequestInit) => {
        appels.push({ url, init });
        if (o.jeter) throw o.jeter;
        return new Response(o.corps ?? JSON.stringify(ficheValide), { status: o.statut ?? 200 });
      }) as unknown as typeof fetch,
      verifier: async () => (o.verdict === false ? { ok: false, raison: 'adresse interne' } : { ok: true }),
      maintenant: () => t,
    });
    return { lecteur, appels, avancer: (ms: number) => { t += ms; } };
  }

  it('une fiche valide : le nom déclaré, le domaine qui prouve l’éditeur, ses adresses ; sans suivre de redirection', async () => {
    const { lecteur, appels } = monter();
    expect(await lecteur.lire(ID)).toEqual({
      id: ID, nom: 'ChatGPT', adressesDeRetour: ['https://chatgpt.com/connector_platform_oauth_redirect'], marque: 'domaine', domaine: 'chatgpt.com',
    });
    expect(appels).toHaveLength(1);
    expect(appels[0]!.init?.redirect).toBe('error');
  });

  it('🔴 refusée : client_id différent de son adresse, adresse de retour hors politique, JSON illisible, HTTP en échec', async () => {
    for (const corps of [
      JSON.stringify({ ...ficheValide, client_id: 'https://evil.test/fiche.json' }),
      JSON.stringify({ ...ficheValide, redirect_uris: ['cursor://x/cb'] }),
      JSON.stringify({ ...ficheValide, redirect_uris: [] }),
      'pas du json',
    ]) expect(await monter({ corps }).lecteur.lire(ID), corps).toBeNull();
    expect(await monter({ statut: 404 }).lecteur.lire(ID)).toBeNull();
  });

  it('🔴 une adresse interne n’est jamais appelée, et un corps trop gros est refusé', async () => {
    const interne = monter({ verdict: false });
    expect(await interne.lecteur.lire(ID)).toBeNull();
    expect(interne.appels).toHaveLength(0);
    const gros = JSON.stringify({ ...ficheValide, client_name: 'x'.repeat(PLAFOND_FICHE_OCTETS) });
    expect(await monter({ corps: gros }).lecteur.lire(ID)).toBeNull();
  });

  it('un nom illisible, invisible, trop long ou celui de Claude laisse le domaine tenir lieu de nom', async () => {
    for (const nom of ['a\u0007b', 'Clau\u200bde', 'abc\u202edef', 'x'.repeat(101), 'Claude', 'CLAUDE CODE', 'Anthropic']) {
      const { lecteur } = monter({ corps: JSON.stringify({ ...ficheValide, client_name: nom }) });
      expect((await lecteur.lire(ID))?.nom, JSON.stringify(nom)).toBe('chatgpt.com');
    }
    expect(nomAffichable('ChatGPT')).toBe('ChatGPT');
  });

  it('le cache : une fiche valide sert 10 minutes, un échec 1 minute', async () => {
    const ok = monter();
    await ok.lecteur.lire(ID);
    ok.avancer(CACHE_FICHE_MS - 1);
    await ok.lecteur.lire(ID);
    expect(ok.appels).toHaveLength(1);
    ok.avancer(2);
    await ok.lecteur.lire(ID);
    expect(ok.appels).toHaveLength(2);

    const ko = monter({ statut: 500 });
    await ko.lecteur.lire(ID);
    ko.avancer(CACHE_ECHEC_MS - 1);
    await ko.lecteur.lire(ID);
    expect(ko.appels).toHaveLength(1);
    ko.avancer(2);
    await ko.lecteur.lire(ID);
    expect(ko.appels).toHaveLength(2);
  });

  it('une forme qui n’est pas celle d’une fiche ne fait partir aucune requête', async () => {
    const { lecteur, appels } = monter();
    for (const id of ['http://chatgpt.com/x', 'https://chatgpt.com/', 'https://claude.ai/oauth/mcp-oauth-client-metadata', 'mcl_x']) {
      expect(await lecteur.lire(id)).toBeNull();
    }
    expect(appels).toHaveLength(0);
  });
});
