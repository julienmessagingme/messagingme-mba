import { describe, it, expect } from 'vitest';
import { fetchUrlBorne, urlRecuperable } from '../src/lib/page-distante';

/**
 * La lecture d'une page distante depuis le serveur, et sa garde.
 *
 * 🔴 CE QUE CES TESTS PROTÈGENT. Le serveur tourne dans le réseau Docker du VPS : il voit l'admin NPM, les
 * autres conteneurs, et le service de métadonnées du fournisseur. Deux surfaces lui font lire une adresse
 * SAISIE PAR UN CLIENT (l'import de FAQ de l'agent Meta, l'import de connaissance d'un agent IA). Sans cette
 * garde, la console est un lecteur de l'intérieur du réseau (SSRF) pour tout admin de tenant.
 */
describe('urlRecuperable', () => {
  it('🔴 refuse les hôtes internes et les schémas qui ne sont pas http(s)', () => {
    for (const mauvaise of [
      'http://localhost/admin',
      'http://npm.localhost/',
      'http://api.internal/secret',
      'http://service.local/',
      'http://127.0.0.1:81/api/tokens',
      'http://10.0.0.5/',
      'http://192.168.1.1/',
      'http://172.20.0.1/',
      'http://169.254.169.254/latest/meta-data',
      'http://0.0.0.0/',
      'file:///etc/passwd',
      'ftp://exemple.fr/',
      'javascript:alert(1)',
      'pas une url',
    ]) {
      expect(urlRecuperable(mauvaise), mauvaise).toBe(false);
    }
  });

  it('accepte une adresse publique en http et en https', () => {
    expect(urlRecuperable('https://www.exemple.fr/faq')).toBe(true);
    expect(urlRecuperable('http://exemple.fr/tarifs?a=1')).toBe(true);
    // 172.15 et 172.32 sont HORS de la plage privée 172.16-172.31 : la garde ne doit pas déborder.
    expect(urlRecuperable('http://172.15.0.1/')).toBe(true);
    expect(urlRecuperable('http://172.32.0.1/')).toBe(true);
  });
});

describe('fetchUrlBorne', () => {
  const reponse = (status: number, entetes: Record<string, string>, corps = '') =>
    new Response(corps, { status, headers: entetes }) as Response;

  /**
   * 🔴 LA RÉSOLUTION EST INJECTÉE, ET CE N'EST PAS UN DÉTAIL DE CONFORT (audit de rayon de souffle, 2026-09-04).
   *
   * Ces tests appelaient `fetchUrlBorne(1000, impl)` à DEUX arguments, donc le troisième retombait sur la
   * VRAIE `resolutionPublique`, qui faisait un VRAI appel DNS sur `www.exemple.fr`, un domaine que personne
   * ici ne contrôle. Deux dégâts, tous deux mesurés et non déduits :
   *
   * 1. le premier test passait AUSSI quand le nom ne résolvait pas, parce que « hôte non autorisé (nom
   *    introuvable) » contient bien « hôte non autorisé ». Il était vert par le chemin du REFUS, sans jamais
   *    atteindre la redirection qu'il prétend refuser, et son nom ne le disait pas ;
   * 2. le plafond de résolution ajouté le 2026-09-03 a resserré la marge de ces tests, qui dépendaient
   *    jusque-là du résolveur de la machine de CI.
   *
   * La règle : **un test unitaire qui touche le réseau n'est pas un test unitaire**, c'est un test dont le
   * verdict appartient à quelqu'un d'autre. La dépendance existait déjà pour ça, elle n'était pas câblée.
   */
  const resout = async (): Promise<{ ok: boolean }> => ({ ok: true });
  const borne = (impl: typeof fetch) => fetchUrlBorne(1000, impl, resout);

  it('🔴 une redirection vers un hôte interne est REFUSÉE', async () => {
    // Le contrôle d'origine ne porte que sur l'URL saisie : en suivi automatique, une page publique qui
    // renvoie un 302 vers l'adresse de métadonnées du cloud contournerait tout le garde-fou.
    //
    // ⚠️ La résolution rend TOUJOURS `ok` ici : le refus doit donc venir du contrôle TEXTUEL de l'adresse de
    // redirection, et de lui seul. Sans ça le test serait vert pour la mauvaise raison, ce qu'il était.
    const impl = (async () => reponse(302, { location: 'http://169.254.169.254/latest/meta-data' })) as unknown as typeof fetch;
    await expect(borne(impl)('https://www.exemple.fr/faq')).rejects.toThrow('hôte non autorisé');
  });

  it('🔴 et la résolution est consultée à CHAQUE saut, pas seulement sur l’adresse saisie', async () => {
    // C'est la raison d'être de la boucle : une page publique peut rediriger vers un nom public dont
    // l'enregistrement A pointe vers l'intérieur, et aucun contrôle textuel ne peut le voir.
    const vues: string[] = [];
    const impl = (async () => reponse(302, { location: 'https://autre.exemple.fr/suite' })) as unknown as typeof fetch;
    const compte = async (u: string): Promise<{ ok: boolean }> => { vues.push(u); return { ok: true }; };
    await expect(fetchUrlBorne(1000, impl, compte)('https://www.exemple.fr/faq')).rejects.toThrow('trop de redirections');
    expect(vues).toEqual([
      'https://www.exemple.fr/faq',
      'https://autre.exemple.fr/suite',
      'https://autre.exemple.fr/suite',
      'https://autre.exemple.fr/suite',
    ]);
  });

  it('🔴 un nom qui résout vers l’intérieur est refusé même si son TEXTE est irréprochable', async () => {
    // Le cas que le contrôle textuel ne peut pas voir, et la seule chose que la résolution apporte.
    const impl = (async () => reponse(200, { 'content-type': 'text/html' }, '<p>x</p>')) as unknown as typeof fetch;
    const interne = async (): Promise<{ ok: boolean; raison: string }> => ({ ok: false, raison: 'ce nom pointe vers une adresse interne' });
    await expect(fetchUrlBorne(1000, impl, interne)('https://crm.exemple.fr/faq')).rejects.toThrow('hôte non autorisé');
  });

  it('suit une redirection vers un hôte public, et s’arrête après 3 sauts', async () => {
    let n = 0;
    const impl = (async () => {
      n += 1;
      return n === 1
        ? reponse(301, { location: 'https://www.exemple.fr/faq-v2' })
        : reponse(200, { 'content-type': 'text/html' }, '<dl><dt>Q</dt><dd>R</dd></dl>');
    }) as unknown as typeof fetch;
    expect(await borne(impl)('https://www.exemple.fr/faq')).toMatchObject({ status: 200 });

    const boucle = (async () => reponse(302, { location: 'https://www.exemple.fr/encore' })) as unknown as typeof fetch;
    await expect(borne(boucle)('https://www.exemple.fr/faq')).rejects.toThrow('trop de redirections');
  });

  it('refuse une page qui dépasse le plafond, même si elle ment sur sa taille', async () => {
    const gros = 'x'.repeat(2_000_001);
    const impl = (async () => reponse(200, { 'content-type': 'text/html' }, gros)) as unknown as typeof fetch;
    await expect(borne(impl)('https://www.exemple.fr/faq')).rejects.toThrow('trop lourde');
  });
});
