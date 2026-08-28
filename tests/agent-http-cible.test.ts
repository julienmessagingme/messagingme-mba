import { describe, it, expect } from 'vitest';
import { construireCible, type CibleConstruite } from '../src/agent/http-cible';

/**
 * LA GARDE D'URL D'UN CONNECTEUR. C'est ici que le lot L2 se joue.
 *
 * 🔴 CE QUI ARRIVE SI ELLE SE TROMPE. Le serveur vit dans le réseau Docker du VPS : il voit l'admin NPM, les
 * autres conteneurs et le service de métadonnées du fournisseur. Une adresse mal contrôlée fait d'un
 * connecteur client un lecteur de l'intérieur. Et une valeur mal encodée fait d'un gabarit de chemin un IDOR :
 * il suffirait de demander à l'agent la commande de quelqu'un d'autre.
 *
 * La fonction est PURE : tout se teste sans réseau, et il n'y a donc aucune excuse à ne pas l'éprouver
 * méchamment.
 */
const BASE = 'https://api.client.fr/v1';
const url = (r: ReturnType<typeof construireCible>): string => (r as CibleConstruite).url;

describe('construireCible : l’adresse de base', () => {
  it('🔴 une adresse INTERNE est refusée, sous toutes ses formes', () => {
    // Le serveur voit l'admin NPM (`:81`), les autres conteneurs par leur nom, et le service de métadonnées
    // du VPS. Chacune de ces adresses répondrait à un `fetch` depuis le conteneur.
    for (const base of [
      'http://localhost:8095/v1', 'https://localhost/v1', 'http://127.0.0.1:81/api',
      'https://169.254.169.254/latest/meta-data', 'http://10.0.0.4/api', 'http://192.168.1.10/api',
      'http://172.18.0.1:8120/kb', 'https://mba-api.internal/v1', 'https://truc.local/api',
    ]) {
      expect(construireCible({ baseUrl: base, binding: { methode: 'GET', chemin: '/x' }, args: {} }).ok, base).toBe(false);
    }
  });

  it('🔴 seul HTTPS passe : en clair, le secret d’authentification voyage en clair', () => {
    expect(construireCible({ baseUrl: 'http://api.client.fr/v1', binding: { methode: 'GET', chemin: '/x' }, args: {} }).ok).toBe(false);
    expect(construireCible({ baseUrl: BASE, binding: { methode: 'GET', chemin: '/x' }, args: {} }).ok).toBe(true);
  });

  it('une adresse illisible est refusée sans lever', () => {
    for (const base of ['', '   ', 'pas une url', 'ftp://api.client.fr', 'javascript:alert(1)']) {
      expect(construireCible({ baseUrl: base, binding: { methode: 'GET', chemin: '/x' }, args: {} }).ok, base).toBe(false);
    }
  });
});

describe('construireCible : le gabarit de chemin', () => {
  it('remplit les paramètres et rend l’URL finale', () => {
    const r = construireCible({ baseUrl: BASE, binding: { methode: 'GET', chemin: '/commandes/{ref}' }, args: { ref: 'A-42' } });
    expect(r.ok).toBe(true);
    expect(url(r)).toBe('https://api.client.fr/v1/commandes/A-42');
  });

  it('🔴 une valeur qui contient un SLASH ne change pas le chemin', () => {
    // Sans encodage, `../../admin/users` sortirait de l'espace prévu par le client. C'est la forme la plus
    // simple d'IDOR sur un connecteur, et elle vient du modèle, donc d'un texte qu'un contact influence.
    const r = construireCible({ baseUrl: BASE, binding: { methode: 'GET', chemin: '/commandes/{ref}' }, args: { ref: '../../admin/users' } });
    expect(r.ok).toBe(true);
    expect(url(r)).toBe('https://api.client.fr/v1/commandes/..%2F..%2Fadmin%2Fusers');
  });

  it('🔴 une valeur qui contient « ? » ou « # » n’ajoute pas de paramètres de requête', () => {
    const r = construireCible({ baseUrl: BASE, binding: { methode: 'GET', chemin: '/commandes/{ref}' }, args: { ref: 'A?admin=1#x' } });
    expect(url(r)).toBe('https://api.client.fr/v1/commandes/A%3Fadmin%3D1%23x');
  });

  it('🔴 un gabarit qui REMONTE hors de la base est refusé', () => {
    for (const chemin of ['../secret', '/v1/../../admin', '/./../../etc']) {
      expect(construireCible({ baseUrl: BASE, binding: { methode: 'GET', chemin }, args: {} }).ok, chemin).toBe(false);
    }
  });

  it('🔴 un gabarit qui porte une adresse ABSOLUE est refusé', () => {
    // `new URL('https://evil.test', base)` rend `https://evil.test` : le gabarit changerait d'hôte à lui seul.
    for (const chemin of ['https://evil.test/x', '//evil.test/x', 'http://169.254.169.254/']) {
      expect(construireCible({ baseUrl: BASE, binding: { methode: 'GET', chemin }, args: {} }).ok, chemin).toBe(false);
    }
  });

  it('un paramètre MANQUANT refuse, il ne fabrique pas un chemin à trou', () => {
    // Un chemin `/commandes/` appellerait la liste ENTIÈRE des commandes du client, et l'agent la lirait.
    const r = construireCible({ baseUrl: BASE, binding: { methode: 'GET', chemin: '/commandes/{ref}' }, args: {} });
    expect(r.ok).toBe(false);
    const vide = construireCible({ baseUrl: BASE, binding: { methode: 'GET', chemin: '/commandes/{ref}' }, args: { ref: '   ' } });
    expect(vide.ok).toBe(false);
  });

  it('une valeur non textuelle passe si elle est simple, jamais un objet', () => {
    expect(url(construireCible({ baseUrl: BASE, binding: { methode: 'GET', chemin: '/c/{n}' }, args: { n: 42 } }))).toBe('https://api.client.fr/v1/c/42');
    expect(construireCible({ baseUrl: BASE, binding: { methode: 'GET', chemin: '/c/{n}' }, args: { n: { a: 1 } } }).ok).toBe(false);
    expect(construireCible({ baseUrl: BASE, binding: { methode: 'GET', chemin: '/c/{n}' }, args: { n: null } }).ok).toBe(false);
  });

  it('l’adresse de base garde son chemin, avec ou sans barre finale', () => {
    for (const base of ['https://api.client.fr/v1', 'https://api.client.fr/v1/']) {
      expect(url(construireCible({ baseUrl: base, binding: { methode: 'GET', chemin: '/commandes' }, args: {} })), base)
        .toBe('https://api.client.fr/v1/commandes');
    }
    // Et un chemin sans barre initiale se rattache quand même SOUS la base.
    expect(url(construireCible({ baseUrl: BASE, binding: { methode: 'GET', chemin: 'commandes' }, args: {} })))
      .toBe('https://api.client.fr/v1/commandes');
  });
});

describe('construireCible : la méthode', () => {
  it('les cinq méthodes du lot passent, le reste est refusé', () => {
    for (const methode of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(construireCible({ baseUrl: BASE, binding: { methode, chemin: '/x' }, args: {} }).ok, methode).toBe(true);
    }
    for (const methode of ['CONNECT', 'TRACE', 'OPTIONS', 'get', '', 'GET ']) {
      expect(construireCible({ baseUrl: BASE, binding: { methode, chemin: '/x' }, args: {} }).ok, methode).toBe(false);
    }
  });
});

describe('risqueSelonMethode', () => {
  it('🔴 le risque DÉRIVE de la méthode : un client ne sous-déclare pas son propre connecteur', async () => {
    const { risqueSelonMethode, risqueAuMoins } = await import('../src/agent/http-cible');
    expect(risqueSelonMethode('GET')).toBe('read');
    expect(risqueSelonMethode('POST')).toBe('write');
    expect(risqueSelonMethode('PUT')).toBe('write');
    expect(risqueSelonMethode('PATCH')).toBe('write');
    expect(risqueSelonMethode('DELETE')).toBe('irreversible');
    // On peut MONTER le risque déclaré, jamais le descendre : le descendre désarmerait la garde d'autonomie.
    expect(risqueAuMoins('write', 'irreversible')).toBe(true);
    expect(risqueAuMoins('write', 'write')).toBe(true);
    expect(risqueAuMoins('write', 'read')).toBe(false);
  });
});
