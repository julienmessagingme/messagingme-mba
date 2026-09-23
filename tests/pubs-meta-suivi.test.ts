import { describe, it, expect, vi, afterEach } from 'vitest';
import { MetaPubsCreationClient } from '../src/meta/pubs-creation';

/**
 * CE QUE LE SUIVI DEMANDE À META, ET CE QU'IL EN FAIT.
 *
 * 🔴 CES TESTS SONT NÉS DE DEUX DÉFAUTS TROUVÉS PAR UNE RELECTURE À FROID, et les deux portaient sur de
 * l'argent affiché. Le budget était demandé à la CAMPAGNE alors qu'il vit sur l'ENSEMBLE (`payloadEnsemble`
 * pose `lifetime_budget` sur l'ad set, `payloadCampagne` n'en pose aucun) : selon ce que Meta répondait, on
 * ne rattrapait jamais rien, ou bien on écrasait par zéro le budget saisi par le client. Le second est la
 * conversion : une valeur inattendue devient `NaN`, que Postgres ACCEPTE dans une colonne `numeric`.
 *
 * ⚠️ `fetch` EST REMPLACÉ ICI, donc ces tests ne touchent aucun réseau. Ce qu'ils lisent est l'URL demandée
 * et l'objet rendu : c'est ce qui PART et ce qui REVIENT, pas ce qu'une fonction interne calcule.
 */

const reponse = (corps: unknown): Response => ({
  ok: true,
  status: 200,
  json: async () => corps,
} as Response);

afterEach(() => { vi.unstubAllGlobals(); });

function client(corps: unknown): { c: MetaPubsCreationClient; urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => { urls.push(String(url)); return reponse(corps); });
  return { c: new MetaPubsCreationClient('app', 'secret', 'v23.0'), urls };
}

describe('lireCampagnes : ce qui est demandé', () => {
  it('🔴 le budget est demandé à l’ENSEMBLE, pas à la campagne', async () => {
    const { c, urls } = client({});
    await c.lireCampagnes(['c-1'], 'jeton');
    const url = decodeURIComponent(urls[0] ?? '');
    expect(url).toContain('adsets.limit(1){lifetime_budget}');
    // Demandé à la campagne, le champ serait vide ou nul : `payloadCampagne` ne pose aucun budget.
    expect(url).not.toMatch(/fields=[^&]*,lifetime_budget,/);
  });

  it('demande bien les statuts et les motifs dans le même appel', async () => {
    const { c, urls } = client({});
    await c.lireCampagnes(['c-1'], 'jeton');
    const url = decodeURIComponent(urls[0] ?? '');
    expect(url).toContain('effective_status');
    expect(url).toContain('issues_info');
  });

  it('🔴 le jeton ne voyage JAMAIS dans l’URL : elle est journalisée', async () => {
    const { c, urls } = client({});
    await c.lireCampagnes(['c-1'], 'jeton-secret');
    expect(urls[0]).not.toContain('jeton-secret');
  });

  it('un lot de plus de cinquante identifiants part en PLUSIEURS appels', async () => {
    // Un paquet trop gros ne rendrait pas une réponse partielle : il rendrait une ERREUR, donc zéro suivi
    // pour toutes les campagnes du paquet.
    const { c, urls } = client({});
    await c.lireCampagnes(Array.from({ length: 51 }, (_, i) => `c-${i}`), 'jeton');
    expect(urls).toHaveLength(2);
  });
});

describe('le budget rendu par Meta', () => {
  const lire = async (adsets: unknown): Promise<number | null> => {
    const { c } = client({ 'c-1': { effective_status: 'ACTIVE', adsets } });
    return (await c.lireCampagnes(['c-1'], 'jeton')).get('c-1')?.budgetTotal ?? null;
  };

  it('des unités mineures deviennent l’unité principale', async () => {
    expect(await lire({ data: [{ lifetime_budget: '15000' }] })).toBe(150);
  });

  it('🔴 « 0 » NE DOIT PAS ÉCRASER LE BUDGET SAISI : il vaut « je ne sais pas »', async () => {
    // Le suivi écrit avec un `coalesce` : une valeur non nulle remplace ce que le client a saisi. Un zéro
    // afficherait « peut dépenser jusqu'à 0 » sur une publicité qui va dépenser cent cinquante euros.
    expect(await lire({ data: [{ lifetime_budget: '0' }] })).toBeNull();
  });

  it('🔴 une valeur ILLISIBLE vaut `null`, jamais `NaN` : Postgres accepte `NaN` dans un `numeric`', async () => {
    expect(await lire({ data: [{ lifetime_budget: 'beaucoup' }] })).toBeNull();
  });

  it('aucun ensemble rendu : `null`, et le suivi ne touchera pas à la colonne', async () => {
    expect(await lire({ data: [] })).toBeNull();
    expect(await lire(undefined)).toBeNull();
  });
});

describe('lireDepenses', () => {
  it('rend la dépense et les clics SUR LE LIEN, pas tous les clics', async () => {
    const { c, urls } = client({
      'c-1': { insights: { data: [{ spend: '12.5', inline_link_clicks: '40' }] } },
    });
    const r = (await c.lireDepenses(['c-1'], 'jeton')).get('c-1');
    expect(r).toEqual({ depense: 12.5, clics: 40 });
    // `clicks` compterait tout clic sur la publicité : une réaction, un nom de Page, un déroulé de texte.
    expect(decodeURIComponent(urls[0] ?? '')).toContain('inline_link_clicks');
  });

  it('⚠️ aucune ligne de statistiques est un cas NORMAL : rien n’est rendu pour cette campagne', async () => {
    // Une campagne qui vient d'être publiée n'a encore rien diffusé. Rendre zéro ressemblerait à une mesure.
    const { c } = client({ 'c-1': { insights: { data: [] } } });
    expect((await c.lireDepenses(['c-1'], 'jeton')).has('c-1')).toBe(false);
  });
});
