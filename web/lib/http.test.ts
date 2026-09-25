import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiError, messageDErreur, request } from './http';

/**
 * LE TEXTE QU'UN ÉCRAN AFFICHE QUAND L'API ÉCHOUE (2026-09-22).
 *
 * 🔴 Tous les écrans affichent `err.message` tel quel. Sur une panne de l'API, ce texte était « Internal
 * Server Error » (opaque et en anglais, voulu côté serveur) ou « Erreur 502 » (Cloudflare remplace le corps
 * des 5xx par une page HTML) : aucun des deux ne dit quoi faire.
 */
describe('messageDErreur', () => {
  it('une raison que le serveur a écrite passe telle quelle, quel que soit le statut', () => {
    expect(messageDErreur(422, { error: 'l’essai a échoué : délai dépassé' }, 'fr')).toBe('l’essai a échoué : délai dépassé');
    // Un 503 « non configuré » dit quelque chose que la phrase générique effacerait.
    expect(messageDErreur(503, { error: 'aide indisponible (non configurée)' }, 'fr')).toBe('aide indisponible (non configurée)');
  });

  it('🔴 la panne opaque du serveur devient une phrase, qui garde le statut', () => {
    expect(messageDErreur(500, { error: 'Internal Server Error' }, 'fr')).toBe('Incident de notre côté (erreur 500). Réessayez dans un instant.');
    expect(messageDErreur(500, { error: 'Internal Server Error' }, 'en')).toBe('Something went wrong on our side (error 500). Try again in a moment.');
  });

  it('🔴 la page HTML de Cloudflare (corps illisible) aussi', () => {
    expect(messageDErreur(502, null, 'fr')).toBe('Incident de notre côté (erreur 502). Réessayez dans un instant.');
  });

  it('un 4xx sans raison garde son repli court, et un `error` qui n’est pas un texte n’est pas affiché', () => {
    expect(messageDErreur(404, null, 'fr')).toBe('Erreur 404');
    expect(messageDErreur(404, null, 'en')).toBe('Error 404');
    expect(messageDErreur(400, { error: { code: 'x' } }, 'fr')).toBe('Erreur 400');
    expect(messageDErreur(400, { error: '  ' }, 'fr')).toBe('Erreur 400');
  });
});

describe('request', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('🔴 c’est bien ce texte qui remonte à l’écran : la fonction est BRANCHÉE, pas seulement écrite', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Internal Server Error' }), {
      status: 500, headers: { 'content-type': 'application/json' },
    })));
    // Un POST n'est jamais rejoué : un seul appel, et l'erreur tout de suite.
    const err = await request('/tenants/t1/support', { method: 'POST', body: '{}' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).message).toBe('Incident de notre côté (erreur 500). Réessayez dans un instant.');
  });
});
