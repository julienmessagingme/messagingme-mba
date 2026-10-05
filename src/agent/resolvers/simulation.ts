import type { ResolveurOutil, SortieResolveur } from '../executor';
import type { OrigineOutil } from '../catalog';
import type { KnowledgeStore } from '../knowledge';
import type { RequeteConnecteur, RequeteStore, VariableDeclaree } from '../requetes';
import { chercherConnaissance, type RechercheSemantique } from './connaissance';
import { terminerAvec } from './mba';

/**
 * Le résolveur du bac à sable, quand le client parle à son agent depuis la console : un outil qui lit
 * s'exécute, un outil qui agit est simulé (pas de vrai contact, pas de vraie conversation). La recherche de
 * connaissance tourne vraiment : c'est elle qu'on éprouve.
 *
 * La simulation le dit au modèle, sinon il enchaînerait sur une prémisse fausse.
 */

export interface DepsResolveurSimulation {
  /** La base de connaissance, la vraie : c'est elle qu'on teste. */
  connaissance: KnowledgeStore;
  /** La même recherche sémantique que la production : un bac à sable qui juge autrement ne prouve rien.
   *  Optionnelle, comme en production. */
  recherche?: RechercheSemantique;
}

/** Les connecteurs HTTP du bac à sable. Requis par `resolveursSimulation` : un câblage qui les oublierait
 *  simulerait tout, en silence. */
export interface ConnecteursEssai {
  /** La requête d'un outil : sa méthode et ses variables décident s'il part pour de vrai, son libellé et sa méthode
   *  nomment la simulation. */
  requetes: Pick<RequeteStore, 'parId'>;
  /** Le résolveur de PRODUCTION (`creerResolveurHttp`) : un appel réel passe par les mêmes gardes. */
  reel: ResolveurOutil;
}

function texte(args: Record<string, unknown>, cle: string): string {
  const v = args[cle];
  return typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v).trim();
}

/** Ce qu'un outil à effet rend en bac à sable. `simule: true` est lu par l'écran pour le signaler au client,
 *  et la phrase est lue par le modèle pour qu'il n'enchaîne pas sur une prémisse fausse. */
function simule(quoi: string, details: Record<string, unknown> = {}): SortieResolveur {
  return {
    contenu: {
      simule: true,
      ...details,
      note: `Test hors ligne : ${quoi} n'a PAS eu lieu. Continue la conversation comme si c'était fait.`,
    },
  };
}

/**
 * Un connecteur simulé : les champs demandés, avec une valeur d'exemple.
 *
 * 🔴 Un connecteur qui agit n'est jamais appelé depuis un essai : il n'y a ni vrai contact ni vraie conversation,
 * et l'appel ferait un vrai dégât. Seul un connecteur qui lit part pour de vrai (`connecteurEssai`).
 * L'appel est nommé par le libellé et la méthode de sa requête (le `binding` d'un connecteur est vide), jamais par
 * son chemin : la note part chez le fournisseur du modèle, et le chemin d'un webhook porte souvent son jeton.
 */
export function connecteurSimule(
  outil: { origin?: string; binding: Record<string, unknown>; outputPaths: string[] },
  requete: Pick<RequeteConnecteur, 'label' | 'methode'> | null = null,
): SortieResolveur {
  const b = outil.binding as { outilDistant?: unknown };

  /**
   * Un outil MCP n'a ni méthode ni chemin, et ne déclare aucun champ à lire (un serveur MCP rend du texte, le
   * filtre par chemins ne s'applique pas) : on rend un texte d'exemple, la forme réelle de sa réponse.
   */
  if (outil.origin === 'mcp') {
    const nom = String(b.outilDistant ?? '?');
    return simule(`l'appel de l'outil « ${nom} » sur votre serveur MCP`, {
      texte: `exemple de ce que « ${nom} » répondrait`,
    });
  }

  const contenu: Record<string, unknown> = {};
  for (const chemin of outil.outputPaths) contenu[chemin] = `exemple(${chemin})`;
  const appel = requete ? `l'appel « ${requete.label} » (${requete.methode})` : 'l\'appel';
  return simule(`${appel} vers votre système`, { champs: contenu });
}

/** Une variable que seul un vrai contact remplit. Au bac à sable, il n'y en a pas : elle vaudrait `null`, ou
 *  `bac-a-sable` pour `wa_id`, une valeur inventée que le résolveur s'interdit d'envoyer. */
const duContact = (v: VariableDeclaree): boolean =>
  v.origine.type === 'fiche' || v.origine.type === 'champ'
  || (v.origine.type === 'systeme' && v.origine.cle === 'derniere_saisie');

/**
 * Un connecteur HTTP au bac à sable. Un connecteur qui LIT part POUR DE VRAI, par le résolveur de production, donc
 * avec ses gardes (filtre de sortie, adresse interne, redirection, corps borné) : c'est le seul moyen d'éprouver un
 * devis sans conversation réelle (décision de Julien, 2026-10-05). Le reste est simulé.
 *
 * 🔴 « Qui lit » se juge sur quatre faits : la requête est un GET (ce qui part sur le réseau), l'outil intègre la
 * réponse (« il pousse » est la déclaration du client qu'il agit), son risque est resté `read` (dérivé de la
 * méthode à la création, il ne suit pas une requête qui en change ensuite), et aucune variable ne vient du contact.
 */
function connecteurEssai(c: ConnecteursEssai): ResolveurOutil {
  return async (entree) => {
    const requestId = typeof entree.outil.requestId === 'string' ? entree.outil.requestId : '';
    const requete = requestId === '' ? null : await c.requetes.parId(entree.ctx.tenantId, requestId);
    if (requete && requete.methode === 'GET' && entree.outil.nature === 'integre' && entree.outil.risk === 'read'
      && !requete.variables.some(duContact)) return c.reel(entree);
    return connecteurSimule(entree.outil, requete);
  };
}

/**
 * Le bac à sable pour toutes les origines. `Record<OrigineOutil, ...>` est la garde : l'exécuteur dispatche
 * sur `resolveurs[outil.origin]`, et une origine absente ferait échouer l'essai en `erreur_protocole`. Une
 * origine ajoutée ne compile plus tant que le bac à sable ne l'a pas.
 */
export function resolveursSimulation(
  deps: DepsResolveurSimulation & { connecteurs: ConnecteursEssai },
): Record<OrigineOutil, ResolveurOutil> {
  const simulation = creerResolveurSimulation(deps);
  return { mba: simulation, http: connecteurEssai(deps.connecteurs), mcp: simulation };
}

export function creerResolveurSimulation(deps: DepsResolveurSimulation): ResolveurOutil {
  return async ({ outil, args, ctx }) => {
    // Un outil de connecteur n'a pas de `handler` : il se reconnaît à son origine, et il est simulé en bloc. Le bac
    // à sable de la console branche `http` sur `connecteurEssai`, qui appelle pour de vrai un connecteur qui lit.
    if (outil.origin !== 'mba') return connecteurSimule(outil);
    const handler = String(outil.binding.handler ?? '').trim();
    switch (handler) {
      // ---------- Ceux qui tournent pour de vrai ----------

      case 'chercher_connaissance': {
        const requete = texte(args, 'requete');
        if (requete === '') return { ok: false, contenu: { erreur: 'parametre « requete » manquant' }, erreur: 'requete manquante' };
        // Même verdict qu'en production, sortie comprise : la règle et la recherche sont partagées
        // (`resolvers/connaissance.ts`), un bac à sable plus indulgent mentirait sur ce que l'agent transférera.
        return chercherConnaissance(deps.connaissance, ctx, requete, deps.recherche);
      }

      // Aucun contact dans un bac à sable : l'agent est éprouvé face à un inconnu, le cas d'un premier message.
      case 'lire_contact':
        return { contenu: { connu: false } };

      // Terminer n'a aucun effet de bord : exécuté vraiment, par le handler de production, le panneau montre par
      // quelle règle l'agent sort et avec quel dernier message.
      case 'terminer':
        return terminerAvec(args);

      // ---------- Ceux qui agissent, donc simulés ----------

      case 'poser_tag':
        return simule('la pose du tag', { tag: texte(args, 'tag') });
      case 'ecrire_variable':
        return simule('l ecriture du champ', { cle: texte(args, 'cle'), valeur: texte(args, 'valeur') });
      case 'envoyer_bloc':
        return simule('l envoi du bloc', { code: texte(args, 'code') });
      case 'escalader':
        // `rendu` n'est pas posé : il n'y a personne à qui passer la main, et arrêter le tour cacherait ce que
        // l'agent aurait dit ensuite.
        return simule('le transfert vers un humain');

      default:
        return { ok: false, contenu: { erreur: `outil maison inconnu : ${handler || '(handler absent)'}` }, erreur: 'handler inconnu' };
    }
  };
}
