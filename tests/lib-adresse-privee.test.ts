import { describe, it, expect } from 'vitest';
import { estAdressePrivee, resolutionPublique } from '../src/lib/adresse-privee';
import { lireCorpsBorne } from '../src/lib/corps-borne';

/**
 * LES DEUX BORNES DE SÉCURITÉ DES APPELS SORTANTS (constat A3 de l'audit externe du 2026-09-02).
 *
 * 🔴 Ce qui manquait. Le repo refusait les hôtes internes sur leur TEXTE (`localhost`, `169.254.169.254`,
 * `172.18.0.1`, et même leurs formes hexadécimale, entière et IPv6 : vérifié le 2026-09-03, il les rejette
 * toutes). Mais `crm.exemple.fr` est un nom public dont l'enregistrement A peut pointer vers le réseau
 * Docker du VPS ou vers le service de métadonnées du fournisseur, et aucun contrôle textuel ne peut voir ça.
 */
describe('adresses interdites à un appel sortant', () => {
  it('🔴 les deux espaces qui comptent ici : les métadonnées cloud et le réseau Docker du VPS', () => {
    // Ce ne sont pas des exemples théoriques : `169.254.169.254` sert les identifiants du fournisseur, et
    // `172.18.0.1` est la passerelle du réseau où vivent l'admin NPM et tous les conteneurs du parc.
    expect(estAdressePrivee('169.254.169.254')).toBe(true);
    expect(estAdressePrivee('172.18.0.1')).toBe(true);
  });

  it('couvre les autres espaces privés, la boucle locale, le CGNAT et le multicast', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '0.0.0.0', '192.168.1.1', '172.31.255.254', '100.64.0.1', '198.18.0.1', '239.1.2.3']) {
      expect(estAdressePrivee(ip), ip).toBe(true);
    }
  });

  it('🔴 la famille IPv6 aussi : en laisser une passer suffit à rendre la garde inutile', () => {
    // Une machine à double pile résout souvent les deux, et la pile réseau choisit. Ne contrôler que l'IPv4
    // revient à ne rien contrôler sur un hôte moderne.
    for (const ip of ['::1', '::', 'fe80::1', 'fd00::1', 'fc00::abcd', 'ff02::1', '64:ff9b::a00:1']) {
      expect(estAdressePrivee(ip), ip).toBe(true);
    }
  });

  it('🔴 l’IPv4 mappée en IPv6 est ramenée à sa forme v4', () => {
    // Sans ce repli, `::ffff:169.254.169.254` n'est tout à fait ni de l'IPv4 ni de l'IPv6 et passe entre les
    // deux jeux de règles.
    expect(estAdressePrivee('::ffff:169.254.169.254')).toBe(true);
    expect(estAdressePrivee('::ffff:10.0.0.1')).toBe(true);
    expect(estAdressePrivee('::ffff:93.184.216.34')).toBe(false);
  });

  it('les adresses publiques restent publiques', () => {
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:2800:220:1:248:1893:25c8:1946']) {
      expect(estAdressePrivee(ip), ip).toBe(false);
    }
  });

  it('une adresse vide ou illisible est refusée, pas acceptée par défaut', () => {
    // Le sens de la garde : on n'autorise que ce qu'on a pu vérifier.
    expect(estAdressePrivee('')).toBe(true);
    expect(estAdressePrivee('   ')).toBe(true);
  });
});

describe('résolution d’un nom avant un appel sortant', () => {
  it('🔴 LE CAS DU LOT : un nom PUBLIC qui pointe vers l’intérieur est refusé', async () => {
    const v = await resolutionPublique('https://crm.exemple.fr/commandes', async () => ['169.254.169.254']);
    expect(v.ok).toBe(false);
    // La raison ne cite JAMAIS l'adresse trouvée : elle renseignerait sur la topologie interne.
    expect(v.raison).not.toContain('169.254');
  });

  it('🔴 UNE SEULE adresse interdite condamne le nom, même parmi des publiques', async () => {
    // « Au moins une publique » laisserait le choix à la pile réseau, donc au hasard.
    const v = await resolutionPublique('https://crm.exemple.fr/x', async () => ['93.184.216.34', '10.1.2.3']);
    expect(v.ok).toBe(false);
  });

  it('un nom qui résout uniquement vers du public passe', async () => {
    const v = await resolutionPublique('https://crm.exemple.fr/x', async () => ['93.184.216.34']);
    expect(v).toEqual({ ok: true });
  });

  it('🔴 une résolution qui ÉCHOUE est un refus, pas un laissez-passer', async () => {
    const v = await resolutionPublique('https://nexistepas.exemple/x', async () => { throw new Error('ENOTFOUND'); });
    expect(v.ok).toBe(false);
    const vide = await resolutionPublique('https://vide.exemple/x', async () => []);
    expect(vide.ok).toBe(false);
  });

  it('un LITTÉRAL est jugé sans résoudre, et la fonction reste juste toute seule', async () => {
    // Elle est appelée depuis plusieurs chemins : une garde qui dépend d'une autre garde ailleurs finit par
    // être appelée sans elle.
    let resolutions = 0;
    const compte = async (): Promise<string[]> => { resolutions += 1; return ['93.184.216.34']; };
    expect((await resolutionPublique('https://169.254.169.254/latest', compte)).ok).toBe(false);
    expect((await resolutionPublique('https://[fd00::1]/x', compte)).ok).toBe(false);
    expect(resolutions).toBe(0);
  });

  it('une URL illisible est refusée', async () => {
    expect((await resolutionPublique('pas une url')).ok).toBe(false);
  });
});

describe('lecture bornée du corps d’une réponse', () => {
  const flux = (octets: number): Response =>
    new Response(new ReadableStream<Uint8Array>({
      start(c) {
        let envoyes = 0;
        while (envoyes < octets) {
          const morceau = Math.min(1024, octets - envoyes);
          c.enqueue(new Uint8Array(morceau).fill(97));
          envoyes += morceau;
        }
        c.close();
      },
    }));

  it('un corps sous le plafond est rendu entier, et sa taille est en OCTETS', async () => {
    const r = await lireCorpsBorne(flux(2048), 4096);
    expect(r.trop_gros).toBe(false);
    expect(r.octets).toBe(2048);
    expect(r.texte.length).toBe(2048);
  });

  it('🔴 le plafond compte des OCTETS, pas des unités UTF-16', async () => {
    // Le défaut fermé : `brut.length` comptait des unités UTF-16, donc un corps d'idéogrammes passait un
    // plafond « en octets » avec trois fois sa taille réelle. « 世 » pèse 3 octets pour 1 unité.
    const texte = '世'.repeat(100); // 300 octets, 100 unités UTF-16
    const r = await lireCorpsBorne(new Response(texte), 200);
    expect(r.octets).toBe(300);
    expect(r.trop_gros).toBe(true);
    // Et l'ancienne mesure aurait dit « ça passe » : c'est exactement l'écart.
    expect(texte.length).toBeLessThan(200);
  });

  it('🔴 au-delà du plafond, on COUPE le flux au lieu de tout charger puis jeter', async () => {
    const r = await lireCorpsBorne(flux(100_000), 4096);
    expect(r.trop_gros).toBe(true);
    expect(r.texte).toBe(''); // on ne tronque pas : un JSON coupé est illisible de toute façon
    // On s'est arrêté PRÈS du plafond, pas au bout des cent kilo-octets : c'est toute la différence entre
    // borner la lecture et vérifier après coup.
    expect(r.octets).toBeLessThan(100_000);
    expect(r.octets).toBeLessThanOrEqual(4096 + 1024);
  });

  it('une réponse SANS flux (faux de test, implémentations exotiques) reste lisible', async () => {
    const sansFlux = { body: null, text: async () => 'bonjour' } as unknown as Response;
    const r = await lireCorpsBorne(sansFlux, 100);
    expect(r).toEqual({ texte: 'bonjour', octets: 7, trop_gros: false });
  });

  it('un corps vide n’est pas « trop gros »', async () => {
    const r = await lireCorpsBorne(new Response(''), 10);
    expect(r).toEqual({ texte: '', octets: 0, trop_gros: false });
  });
});
