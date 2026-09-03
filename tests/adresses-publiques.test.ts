import { describe, it, expect } from 'vitest';
import { adressesPubliques } from '../src/lib/adresses-publiques';

/**
 * LES DEUX BASES D'ADRESSES PUBLIQUES (étape 1 de la bascule Vercel, `docs/PLAN-BASCULE-VERCEL-2026-09-03.md`).
 *
 * 🔴 Ce que ce module ferme. `APP_URL` servait à la fois de base aux liens d'e-mail (des pages du FRONT) et
 * aux adresses que le produit DISTRIBUE et qui sont servies par l'API : liens tracés `/r/`, visuels RCS `/m/`,
 * URL d'un webhook entrant `/w/`. Le jour où le front part sur Vercel et l'API reste sur le VPS, garder une
 * seule variable casse forcément un des deux côtés.
 *
 * ⚠️ Ces adresses partent dans des messages WhatsApp livrés et chez des tiers. Une erreur ici ne se rattrape
 * pas : le test le plus important de ce fichier est donc celui du CAS D'AUJOURD'HUI, qui doit rendre
 * exactement ce que le code rendait avant.
 */
describe('adresses publiques : les deux bases', () => {
  it('🔴 sans PUBLIC_API_URL, tout retombe sur APP_URL : le comportement d’AVANT, au caractère près', () => {
    // C'est ce qui permet de déployer ce code sans rien changer, puis de basculer par une seule variable
    // d'environnement. Une étape 1 qui modifierait une adresse déjà distribuée serait une étape 1 ratée.
    const a = adressesPubliques('https://mba.messagingme.app', '');
    expect(a.racine).toBe('https://mba.messagingme.app');
    // Le préfixe du proxy Next, celui que portait `urlPublique` en dur avant ce module.
    expect(a.avecPrefixe).toBe('https://mba.messagingme.app/api/backend');
  });

  it('🔴 avec PUBLIC_API_URL, le préfixe du proxy DISPARAÎT : il appartenait au proxy, pas aux routes', () => {
    // Le piège que ce module existe pour éviter : le laisser en dur aurait produit
    // `https://api.messagingme.app/api/backend/w/<code>`, une adresse morte donnée à un tiers.
    const a = adressesPubliques('https://engageme.messagingme.app', 'https://api.messagingme.app');
    expect(a.racine).toBe('https://api.messagingme.app');
    expect(a.avecPrefixe).toBe('https://api.messagingme.app');
  });

  it('🔴 les deux bases ne sont PAS la même chaîne tant que l’API n’a pas son nom', () => {
    // Le cas particulier qui se retiendrait mal et se recopierait encore plus mal : `/r/` et `/m/` sont
    // servis à la RACINE (rewrite Next dédié, sans préfixe), `/w/` vit sous `/api/backend`.
    const avant = adressesPubliques('https://mba.messagingme.app', '');
    expect(avant.racine).not.toBe(avant.avecPrefixe);
    const apres = adressesPubliques('https://engageme.messagingme.app', 'https://api.messagingme.app');
    expect(apres.racine).toBe(apres.avecPrefixe);
  });

  it('une barre finale ne change rien, dans un sens comme dans l’autre', () => {
    // `https://x/` et `https://x` doivent produire la même adresse : sinon une variable d'environnement
    // recopiée avec une barre en trop fabriquerait des liens en double barre, livrés tels quels.
    expect(adressesPubliques('https://a.test/', '').racine).toBe('https://a.test');
    expect(adressesPubliques('https://a.test', 'https://b.test/').racine).toBe('https://b.test');
    expect(adressesPubliques('https://a.test///', '').avecPrefixe).toBe('https://a.test/api/backend');
  });

  it('les espaces autour de la valeur sont ignorés', () => {
    // Une variable d'environnement copiée-collée traîne souvent une espace. Elle ne doit pas produire une
    // adresse invalide dans un message déjà parti.
    expect(adressesPubliques('  https://a.test  ', '  https://b.test  ').racine).toBe('https://b.test');
    expect(adressesPubliques('https://a.test', '   ').racine).toBe('https://a.test');
  });
});
