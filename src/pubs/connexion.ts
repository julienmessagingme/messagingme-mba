import { cacheCourt } from '../lib/cache-court';
import { messageDe } from '../lib/erreur';
import { encryptSecret, decryptSecret } from '../crypto/secretbox';
import { estJetonRefuse } from '../meta/graph';
import {
  retirerAncienAcces, sansPrefixeAct,
  type ActifsAccordes, type ClientRetrait, type EtatComptePub, type LiaisonPage, type SortAncienAcces,
} from '../meta/pubs';
import { DejaConnectePub, JetonNonEnregistre, PasDeConnexionPub } from '../http/pubs';
import type { ConnexionPub } from './connexion.pg';

/**
 * LA CONNEXION PUBLICITAIRE D'UN ESPACE : le jeton du client, de l'échange du code à la révocation.
 *
 * 🔴 Le jeton est chiffré ICI, et déchiffré ici pour les gestes de l'écran et de `/ops` (le balayage du worker le
 * déchiffre aussi, pour suivre les publicités) : les routes ne reçoivent qu'un `tenantId`,
 * comme pour l'inscription WhatsApp, donc le jeton ne peut fuiter ni dans un journal, ni dans une réponse, ni
 * dans une trace de pile. Il n'en sort en clair que par `jetonClair`, vers le client de création de la racine.
 * Construit une fois, pour ses deux consommateurs : les routes de l'écran Publicités, et `/ops`, qui dépose un
 * jeton créé à la main. Deux constructions donneraient deux chemins de chiffrement à tenir alignés.
 *
 * L'ordre « Meta d'abord, notre état ensuite » se joue ici, et il s'exécute contre de faux objets
 * (`tests/pubs-connexion.test.ts`) : révoquer avant d'effacer, décider du sort de l'ancien jeton avant de le
 * remplacer, refuser avant d'échanger un code quand une connexion existe.
 */

/** Ce que la connexion sait faire chez Meta. `MetaPubsClient` en est l'implémentation. */
export interface ClientConnexionPub extends ClientRetrait {
  exchangeCode(code: string): Promise<string>;
  actifsAccordes(jeton: string): Promise<ActifsAccordes>;
  etatCompte(comptePubId: string, jeton: string): Promise<EtatComptePub>;
}

/** Les actifs choisis, tels qu'ils sont rangés avec la connexion. */
interface ChoixRange {
  comptePubId: string; compteNom: string | null; pageId: string; pageNom: string | null;
  devise: string | null; fuseau: string | null; pageLiee: LiaisonPage;
}

/** Ce que la connexion lit et écrit chez nous. `PgPubConnexionStore` en est l'implémentation. */
export interface DepotConnexionPub {
  lire(tenantId: string): Promise<ConnexionPub | null>;
  lireJetonChiffre(tenantId: string): Promise<string | null>;
  /** `false` quand une connexion existe déjà : rien n'est écrasé. */
  poserJeton(tenantId: string, jetonChiffre: string, parUserId: string | null): Promise<boolean>;
  choisirActifs(tenantId: string, choix: ChoixRange): Promise<void>;
  /** Efface, repose et rechoisit en une transaction : le geste de `/ops`. */
  remplacer(tenantId: string, jetonChiffre: string, choix: ChoixRange): Promise<void>;
  marquerJetonRejete(tenantId: string): Promise<void>;
  supprimer(tenantId: string): Promise<void>;
}

export interface DepsConnexionPub {
  client: ClientConnexionPub;
  connexions: DepotConnexionPub;
  /** `ENCRYPTION_KEY` : `encryptSecret` lève sur une clé absente ou mal formée. */
  cleChiffrement: string;
}

/** Ce que rend un dépôt par `/ops` : la connexion posée, et le sort de l'ancien jeton. */
export interface ConnexionDeposee {
  comptePubId: string;
  compteNom: string | null;
  pageId: string;
  pageNom: string | null;
  devise: string | null;
  fuseau: string | null;
  pageLiee: LiaisonPage;
  ancienRevoque: SortAncienAcces;
}

export interface GestesConnexionPub {
  /** Le jeton en clair ; `PasDeConnexionPub` quand l'espace n'est pas connecté (la route en fait un 409). */
  jetonClair(tenantId: string): Promise<string>;
  etatCompte(tenantId: string): Promise<EtatComptePub | null>;
  connecter(tenantId: string, code: string, userId: string | null): Promise<ActifsAccordes>;
  actifsAccordes(tenantId: string): Promise<ActifsAccordes>;
  choisir(tenantId: string, choix: { comptePubId: string; pageId: string }): Promise<ConnexionPub>;
  deconnecter(tenantId: string): Promise<{ revoqueChezMeta: boolean }>;
  deposerJeton(tenantId: string, jeton: string, comptePubId: string, pageId: string): Promise<ConnexionDeposee>;
}

export function creerConnexionPub(d: DepsConnexionPub): GestesConnexionPub {
  const { client, connexions } = d;

  /**
   * Micro-cache de l'état du compte publicitaire : deux minutes. La route de l'écran Publicités est hors du
   * plafond « coûteux » (il couperait la page dès que deux personnes la consultent) : sans cache, chaque
   * ouverture ferait un aller-retour Graph. Deux minutes et pas dix : quand un statut ou un moyen de
   * paiement bouge, c'est que le client vient de le corriger chez Meta et revient voir. Un cache par
   * construction, donc par process.
   */
  const etatComptePubCache = cacheCourt<EtatComptePub | null>(2 * 60_000);

  const jetonClair = async (tenantId: string): Promise<string> => {
    const chiffre = await connexions.lireJetonChiffre(tenantId);
    // Une erreur nommée : la route en fait un 409 « pas connecté », et non un 502 « Meta ne répond pas »
    // qui enverrait chercher une panne inexistante.
    if (chiffre === null) throw new PasDeConnexionPub();
    return decryptSecret(chiffre, d.cleChiffrement);
  };

  /**
   * Un jeton refusé se retient, une panne non (« reconnectez-vous » contre « réessayez ») : cela se lit
   * sur le code de Meta (`estJetonRefuse`), jamais sur la phrase, qui se reformule. L'erreur remonte dans
   * les deux cas.
   */
  const noterSiRefus = async <T>(tenantId: string, appel: Promise<T>): Promise<T> => {
    try {
      return await appel;
    } catch (err) {
      if (estJetonRefuse(err)) await connexions.marquerJetonRejete(tenantId);
      throw err;
    }
  };

  return {
    jetonClair,

    etatCompte: async (t) => {
      const etat = await connexions.lire(t);
      const comptePubId = etat?.comptePubId ?? null;
      if (comptePubId === null) return null;
      return etatComptePubCache.lire(`${t}:${comptePubId}`, async () => {
        // Pas de `noterSiRefus` : un refus ici ne doit pas marquer la connexion morte pour un
        // indicateur d'affichage. La route traite déjà l'échec comme « je ne sais pas ».
        return client.etatCompte(comptePubId, await jetonClair(t));
      });
    },

    connecter: async (t, code, userId) => {
      // Refus avant l'échange quand une connexion existe déjà : Meta n'émet alors aucun jeton pour rien.
      // Pas suffisant seul (deux connexions simultanées passeraient) : la ceinture reste l'insertion seule
      // de `poserJeton`.
      if (await connexions.lireJetonChiffre(t) !== null) throw new DejaConnectePub(false);
      const jeton = await client.exchangeCode(code);
      // 🔴 À partir d'ici, Meta a émis un jeton sans expiration. Il est rangé avant de lire les actifs, et
      // son échec a son propre nom : c'est notre panne, et elle laisse un accès vivant dont nous n'avons
      // plus la trace.
      let pose = false;
      try {
        pose = await connexions.poserJeton(t, encryptSecret(jeton, d.cleChiffrement), userId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`jeton publicitaire NON enregistré pour l'espace ${t}, il reste vivant chez Meta:`, messageDe(err));
        throw new JetonNonEnregistre(err);
      }
      // La base a refusé d'écraser une connexion existante (course rare) : le jeton échangé est perdu pour
      // nous, et le client l'apprend dans la réponse.
      // 🔴 Ne pas le révoquer ici : `DELETE /me/permissions/...` porte sur le couple (application, entité),
      // pas sur le jeton, et révoquer avec le neuf retirerait probablement les permissions de l'ancien,
      // donc de la connexion en place (hypothèse non mesurée). Un orphelin rare plutôt que ce risque.
      if (!pose) {
        // eslint-disable-next-line no-console
        console.error(`connexion publicitaire concurrente sur l'espace ${t} : un jeton a été émis par Meta et n'a pas été gardé`);
        throw new DejaConnectePub(true);
      }
      return client.actifsAccordes(jeton);
    },

    actifsAccordes: async (t) => noterSiRefus(t, client.actifsAccordes(await jetonClair(t))),

    choisir: async (t, choix) => {
      const jeton = await jetonClair(t);
      // La devise et le fuseau viennent de la liste des actifs, qui les porte déjà : les relire compte par
      // compte serait un appel pour rien et une seconde vérité, qui pourrait diverger de celle qui a
      // validé le choix.
      const actifs = await noterSiRefus(t, client.actifsAccordes(jeton));
      const compte = actifs.comptesPub.find((c) => c.id === choix.comptePubId);
      const page = actifs.pages.find((p) => p.id === choix.pageId);
      // `inconnu` sans appeler Meta : aucune API n'expose la liaison Page / numéro (détail dans
      // `src/meta/pubs.ts`). L'écran dit où la voir chez Meta plutôt que de prétendre la connaître.
      const pageLiee = 'inconnu' as const;
      await connexions.choisirActifs(t, {
        ...choix,
        // Les noms sont gardés ici et nulle part ailleurs : l'écran les relirait sinon chez Meta à chaque
        // ouverture.
        compteNom: compte?.nom ?? null,
        pageNom: page?.nom ?? null,
        devise: compte?.devise ?? null,
        fuseau: compte?.fuseau ?? null,
        pageLiee,
      });
      const etat = await connexions.lire(t);
      if (etat === null) throw new Error('connexion publicitaire introuvable après enregistrement');
      return etat;
    },

    deconnecter: async (t) => {
      // 🔴 Révoquer d'abord, effacer ensuite : notre ligne est la seule copie de ce jeton sans expiration,
      // l'effacer sans tenter le retrait laisserait un accès vivant que nous ne pourrions plus fermer.
      const chiffre = await connexions.lireJetonChiffre(t);
      let revoqueChezMeta = false;
      if (chiffre !== null) {
        try {
          await client.revoquerAcces(decryptSecret(chiffre, d.cleChiffrement));
          revoqueChezMeta = true;
        } catch (err) {
          // Un échec n'empêche pas de se déconnecter : bloquer sur une panne de Meta retiendrait un client
          // qui veut partir.
          // 🔴 Le booléen ne va pas à l'écran : on ne prescrit jamais « retirer l'application », qui
          // couperait aussi le numéro WhatsApp (c'est la même application), et le jeton résiduel n'est
          // détenu par personne. Il sert à mesurer si le retrait fonctionne, et va au journal.
          // eslint-disable-next-line no-console
          console.warn('retrait d’accès publicitaire non confirmé par Meta:', messageDe(err));
        }
      }
      await connexions.supprimer(t);
      return { revoqueChezMeta };
    },

    /**
     * Déposer un jeton publicitaire créé à la main, depuis `/ops` : la fenêtre Meta ne peut pas servir notre
     * propre portefeuille (Meta exige que celui du client soit distinct de celui qui possède l'application).
     * 🔴 Le jeton est vérifié chez Meta avant d'être gardé, par les mêmes appels que la connexion par
     * l'écran. Il remplace une connexion existante, là où l'écran la refuse : `/ops` est notre surface
     * d'exploitation, où remplacer est précisément ce qu'on vient faire.
     */
    deposerJeton: async (tenantId, jeton, comptePubId, pageId) => {
      const actifs = await client.actifsAccordes(jeton);
      const compte = actifs.comptesPub.find((c) => c.id === sansPrefixeAct(comptePubId));
      const page = actifs.pages.find((p) => p.id === pageId);
      if (compte === undefined) throw new Error(`ce jeton n'accorde pas le compte publicitaire ${comptePubId}`);
      if (page === undefined) throw new Error(`ce jeton n'accorde pas la Page ${pageId}`);
      const pageLiee = 'inconnu' as const; // Meta n'expose pas la liaison (cf. `src/meta/pubs.ts`).
      // 🔴 Chiffrer avant de toucher à quoi que ce soit : `encryptSecret` lève sur une clé absente ou mal
      // formée, et une levée plus bas détruirait la connexion existante sans rien ranger.
      const chiffreNeuf = encryptSecret(jeton, d.cleChiffrement);
      // 🔴 Révoquer l'ancien seulement si c'est une autre entité, sinon on tue le neuf. Le raisonnement et
      // ses cinq issues vivent dans `retirerAncienAcces` (`src/meta/pubs.ts`) : ce geste ne fait que
      // déléguer, avec l'ancien DÉCHIFFRÉ et le neuf en clair, AVANT le remplacement (une fois `remplacer`
      // passé, l'ancien est perdu et plus personne ne peut décider de son sort).
      const ancien = await connexions.lireJetonChiffre(tenantId);
      const ancienRevoque = await retirerAncienAcces(
        client,
        ancien === null ? null : decryptSecret(ancien, d.cleChiffrement),
        jeton,
      );
      await connexions.remplacer(tenantId, chiffreNeuf, {
        comptePubId: compte.id, compteNom: compte.nom, pageId: page.id, pageNom: page.nom,
        devise: compte.devise, fuseau: compte.fuseau, pageLiee,
      });
      return {
        comptePubId: compte.id, compteNom: compte.nom, pageId: page.id, pageNom: page.nom,
        devise: compte.devise, fuseau: compte.fuseau, pageLiee, ancienRevoque,
      };
    },
  };
}
