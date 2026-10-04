import type { ResolveurOutil, SortieResolveur } from '../executor';
import type { OrigineOutil } from '../catalog';
import type { KnowledgeStore } from '../knowledge';
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
 * Un connecteur en bac à sable : simulé, jamais appelé.
 *
 * 🔴 Un essai ne tape pas sur le système de production d'un client, même en lecture : quota, journaux, et un
 * connecteur mal déclaré (un `DELETE` au lieu d'un `GET`) ferait un vrai dégât. On rend les champs demandés
 * avec une valeur d'exemple.
 */
export function connecteurSimule(
  outil: { origin?: string; binding: Record<string, unknown>; outputPaths: string[] },
): SortieResolveur {
  const b = outil.binding as { methode?: unknown; chemin?: unknown; outilDistant?: unknown };

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
  return simule(
    `l'appel ${String(b.methode ?? '?')} ${String(b.chemin ?? '?')} vers votre système`,
    { champs: contenu },
  );
}

/**
 * Le bac à sable pour toutes les origines. `Record<OrigineOutil, ...>` est la garde : l'exécuteur dispatche
 * sur `resolveurs[outil.origin]`, et une origine absente ferait échouer l'essai en `erreur_protocole`. Une
 * origine ajoutée ne compile plus tant que le bac à sable ne l'a pas.
 */
export function resolveursSimulation(deps: DepsResolveurSimulation): Record<OrigineOutil, ResolveurOutil> {
  const simulation = creerResolveurSimulation(deps);
  return { mba: simulation, http: simulation, mcp: simulation };
}

export function creerResolveurSimulation(deps: DepsResolveurSimulation): ResolveurOutil {
  return async ({ outil, args, ctx }) => {
    // Un outil de connecteur n'a pas de `handler` : il se reconnaît à son origine, et il est simulé en bloc.
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
