import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { ENTETES_SECURITE_API, CSP_API } from '../src/http/entetes-securite';

/**
 * Les en-têtes de sécurité de l'API (plan RSSI du 2026-09-09, livrés le 2026-09-10).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE, et ce n'est pas la présence des en-têtes : c'est qu'ils soient là SUR LES
 * RÉPONSES D'ERREUR. Une adresse devinée rend une 404, c'est-à-dire la première réponse que voit un
 * scanner, et c'est celle qu'un test qui ne regarde qu'un 200 laisse passer.
 *
 * ⚠️ Ce test ne départage PAS `onSend` de `onRequest` : mesuré par mutation le 2026-09-10, les deux
 * couvrent la 404. Le savoir évite de croire que ce fichier garde un choix qu'il ne garde pas.
 */
const app = () => buildServer({ queue: new FakeQueue() });

describe('en-têtes de sécurité de l’API', () => {
  it('posés sur une réponse normale', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    for (const [nom, valeur] of Object.entries(ENTETES_SECURITE_API)) {
      expect(res.headers[nom], `en-tête ${nom}`).toBe(valeur);
    }
    await a.close();
  });

  it('🔴 posés AUSSI sur une réponse d’erreur', async () => {
    // La raison d'être du `onSend`. Une 404 n'est pas un cas exotique ici : c'est ce que rend une adresse
    // devinée, donc la réponse qu'un scanner voit en premier.
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/chemin-qui-n-existe-pas' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toBe(CSP_API);
    await a.close();
  });

  it('🔴 la CSP de l’API ne s’ouvre pas aux deux relâchements qui la videraient', async () => {
    // Une CSP se relâche par petites touches, chacune raisonnable sur le moment. Ces deux-là ne le sont
    // jamais sur une API : `script-src 'unsafe-inline'` rouvre exactement le XSS que la politique ferme, et
    // un `default-src` en `*` rend le reste décoratif.
    expect(CSP_API).toContain("default-src 'none'");
    expect(CSP_API).toContain("frame-ancestors 'none'");
    expect(CSP_API).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(CSP_API).not.toMatch(/default-src[^;]*\*/);
  });

  it('le référent ne fuit pas : une adresse de l’API porte des identifiants', async () => {
    // `/r/<code>/<jeton>` identifie un destinataire. Un référent envoyé au site de destination le lui
    // livrerait. C'est le seul de ces en-têtes qui ferme une fuite réelle et non hypothétique.
    expect(ENTETES_SECURITE_API['referrer-policy']).toBe('no-referrer');
  });
});
