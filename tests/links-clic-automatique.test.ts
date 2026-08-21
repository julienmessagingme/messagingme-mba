import { describe, it, expect } from 'vitest';
import { estClicAutomatique } from '../src/links/clic-automatique';

/**
 * Les cas de ce fichier ne sont pas inventés : ce sont les en-têtes RÉELS relevés dans les logs d'accès de
 * la production le 2026-08-21, sur le lien `/r/ebagp4wdfn3t` du template `testurl`. Ce template n'avait
 * jamais été envoyé à qui que ce soit, et pourtant 70 requêtes l'avaient atteint.
 */

/** Agent exact du robot d'exploration de Meta, tel qu'il apparaît 58 fois dans les logs. */
const FB_CRAWLER = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
/** Navigateur d'un relecteur de Meta, arrivé du redirecteur Facebook (mesuré 11 fois, dont 6 avec fbclid). */
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7.5 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36';

describe('estClicAutomatique : ne compter que des clics de destinataires', () => {
  it('🔴 le robot d’exploration de Meta ne compte pas (58 des 70 faux clics mesurés)', () => {
    expect(estClicAutomatique({ userAgent: FB_CRAWLER })).toBe(true);
  });

  it('🔴 `facebookexternalua` non plus : c’est le même robot sous un autre nom', () => {
    expect(estClicAutomatique({ userAgent: 'facebookexternalua' })).toBe(true);
  });

  it('🔴 un VRAI navigateur qui arrive de Facebook ne compte pas : c’est la revue du template', () => {
    // Le cas le plus traître : l'agent est irréprochable, seul le référent trahit l'origine. Un destinataire
    // WhatsApp n'arrive JAMAIS de facebook.com.
    expect(estClicAutomatique({ userAgent: IPHONE, referer: 'https://www.facebook.com/' })).toBe(true);
    expect(estClicAutomatique({ userAgent: ANDROID, referer: 'https://lm.facebook.com/' })).toBe(true);
    expect(estClicAutomatique({ userAgent: ANDROID, referer: 'http://m.facebook.com' })).toBe(true);
  });

  it('🔴 un `fbclid` dans l’URL suffit à écarter : Facebook le pose en sortie de son redirecteur', () => {
    expect(estClicAutomatique({ userAgent: IPHONE, parametres: { fbclid: 'IwcGRvZgRleHRuA2FlbQIxMQ' } })).toBe(true);
  });

  it('🔴 un destinataire qui clique depuis WhatsApp COMPTE (sans référent, agent de navigateur)', () => {
    // C'est le cas que tout le reste doit protéger. Le filtre n'a de valeur que s'il laisse passer celui-ci.
    expect(estClicAutomatique({ userAgent: IPHONE })).toBe(false);
    expect(estClicAutomatique({ userAgent: ANDROID })).toBe(false);
    expect(estClicAutomatique({ userAgent: IPHONE, referer: null, parametres: {} })).toBe(false);
  });

  it('un agent ABSENT compte quand même : effacer le clic d’un vrai client est pire', () => {
    expect(estClicAutomatique({})).toBe(false);
    expect(estClicAutomatique({ userAgent: '' })).toBe(false);
    expect(estClicAutomatique({ userAgent: null })).toBe(false);
  });

  it('🔴 `notfacebook.com` n’est PAS Facebook (pas de comparaison par simple suffixe)', () => {
    expect(estClicAutomatique({ userAgent: IPHONE, referer: 'https://notfacebook.com/page' })).toBe(false);
    expect(estClicAutomatique({ userAgent: IPHONE, referer: 'https://facebook.com.evil.fr/' })).toBe(false);
  });

  it('un référent illisible ne présume rien : on laisse compter', () => {
    expect(estClicAutomatique({ userAgent: IPHONE, referer: 'pas une url' })).toBe(false);
  });

  it('un référent légitime quelconque compte (le client peut venir de son propre site)', () => {
    expect(estClicAutomatique({ userAgent: IPHONE, referer: 'https://www.client.fr/promo' })).toBe(false);
  });

  it('le fond de robots d’une URL publique est écarté', () => {
    for (const agent of [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
      'curl/8.5.0',
      'Wget/1.21.3',
      'python-requests/2.31.0',
      'Go-http-client/2.0',
      'okhttp/4.12.0',
      'HeadlessChrome/120.0.0.0',
      'Mozilla/5.0 (compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)',
    ]) {
      expect(estClicAutomatique({ userAgent: agent }), agent).toBe(true);
    }
  });

  it('la casse de l’agent n’a pas d’importance', () => {
    expect(estClicAutomatique({ userAgent: 'FacebookExternalHit/1.1' })).toBe(true);
  });
});

/**
 * Le faux positif est le défaut le plus grave de ce filtre : il efface le clic d'un vrai client, en silence
 * et sans recours. Ces cas verrouillent la forme ANCRÉE des marqueurs.
 */
describe('aucun vrai téléphone ne doit être pris pour un robot', () => {
  it('🔴 un CUBOT compte : « bot » ne doit pas être testé en sous-chaîne libre', () => {
    // CUBOT est une marque d'Android vendue en Europe, et le nom de modèle figure dans le user-agent.
    // Avec un marqueur `bot` nu, tous ses porteurs voyaient leurs clics disparaître.
    const cubot = 'Mozilla/5.0 (Linux; Android 13; CUBOT NOTE 40) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
    expect(estClicAutomatique({ userAgent: cubot })).toBe(false);
  });

  it('🔴 les autres noms d’appareil qui contiennent un marqueur restent comptés', () => {
    for (const agent of [
      'Mozilla/5.0 (Linux; Android 14; Redmi Note 13) AppleWebKit/537.36 Chrome/122.0.0.0 Mobile Safari/537.36',
      'Mozilla/5.0 (Linux; Android 12; SPIDER X1) AppleWebKit/537.36 Chrome/110.0.0.0 Mobile Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
    ]) {
      expect(estClicAutomatique({ userAgent: agent }), agent).toBe(false);
    }
  });

  it('les robots gardent leur nom COMPLET dans la liste', () => {
    for (const agent of ['Googlebot/2.1', 'PetalBot', 'AhrefsBot/7.0', 'Twitterbot/1.0', 'Slackbot-LinkExpanding 1.0']) {
      expect(estClicAutomatique({ userAgent: agent }), agent).toBe(true);
    }
  });
});
