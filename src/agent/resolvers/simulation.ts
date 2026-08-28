import type { ResolveurOutil, SortieResolveur } from '../executor';
import { ficheEstPertinente, type KnowledgeStore } from '../knowledge';
import { SORTIE_SANS_SOURCE } from '../sorties';

/**
 * Le résolveur du BAC À SABLE : celui qui sert quand le client parle à son agent depuis la console.
 *
 * 🔴 CE QUI TOURNE POUR DE VRAI, ET CE QUI EST SIMULÉ. La règle est simple et elle est celle du monde réel :
 * un outil qui LIT s'exécute, un outil qui AGIT est simulé. Il n'y a ni contact, ni conversation, ni
 * parcours dans un bac à sable : poser un tag écrirait sur une vraie fiche du mini-CRM, envoyer un bloc
 * partirait chez un vrai numéro, escalader remonterait une conversation fantôme dans l'inbox d'une équipe.
 *
 * La recherche de connaissance, elle, s'exécute vraiment, et c'est le point : c'est elle qu'on veut
 * éprouver. Un panneau de test qui simulerait aussi la recherche ne dirait rien de ce que l'agent répondra,
 * puisque tout ce qu'il a le droit de dire vient de là.
 *
 * ⚠️ La simulation le DIT au modèle, dans sa réponse. Lui laisser croire que l'action a eu lieu ferait un
 * test menteur : l'agent enchaînerait comme si le tag était posé, et le client réglerait la suite de sa
 * conversation sur une prémisse fausse.
 */

export interface DepsResolveurSimulation {
  /** La base de connaissance, la VRAIE : c'est elle qu'on teste. */
  connaissance: KnowledgeStore;
}

/** Mêmes bornes que le résolveur de production (`resolvers/mba.ts`) : le bac à sable doit rendre au modèle
 *  exactement ce que la production lui rendrait, sans quoi il ne teste pas la même chose. */
const FICHES_RENDUES = 3;
const CORPS_MAX = 2_000;
const REQUETE_MAX = 512;

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
 * Un CONNECTEUR en bac à sable : simulé, jamais appelé.
 *
 * 🔴 UN ESSAI DEPUIS LA CONSOLE NE DOIT PAS TAPER SUR LE SYSTÈME DE PRODUCTION D'UN CLIENT, même en lecture.
 * Il consommerait son quota, apparaîtrait dans ses journaux, et un connecteur mal déclaré (un `DELETE` là où
 * le client voulait un `GET`) ferait un dégât réel pendant qu'on croit essayer. Le bac à sable rend donc les
 * champs DEMANDÉS avec une valeur d'exemple : le client voit exactement ce que l'agent recevra, sans l'appel.
 */
export function connecteurSimule(outil: { binding: Record<string, unknown>; outputPaths: string[] }): SortieResolveur {
  const b = outil.binding as { methode?: unknown; chemin?: unknown };
  const contenu: Record<string, unknown> = {};
  for (const chemin of outil.outputPaths) contenu[chemin] = `exemple(${chemin})`;
  return simule(
    `l'appel ${String(b.methode ?? '?')} ${String(b.chemin ?? '?')} vers votre système`,
    { champs: contenu },
  );
}

export function creerResolveurSimulation(deps: DepsResolveurSimulation): ResolveurOutil {
  return async ({ outil, args, ctx }) => {
    // Un outil de connecteur n'a pas de `handler` : il se reconnaît à son ORIGINE, et il est simulé en bloc.
    if (outil.origin !== 'mba') return connecteurSimule(outil);
    const handler = String(outil.binding.handler ?? '').trim();
    switch (handler) {
      // ---------- Ceux qui tournent POUR DE VRAI ----------

      case 'chercher_connaissance': {
        const requete = texte(args, 'requete').slice(0, REQUETE_MAX);
        if (requete === '') return { ok: false, contenu: { erreur: 'parametre « requete » manquant' }, erreur: 'requete manquante' };
        const fiches = await deps.connaissance.chercher(ctx.tenantId, ctx.agentId, requete, FICHES_RENDUES);
        const retenues = fiches.filter(ficheEstPertinente);
        // Même verdict qu'en production, y compris la SORTIE : c'est le garde-fou anti-hallucination, et un
        // bac à sable qui l'adoucirait laisserait croire que l'agent sait répondre là où il transférera.
        if (retenues.length === 0) return { contenu: { aucune_source: true }, sortie: SORTIE_SANS_SOURCE };
        return {
          contenu: {
            sources: retenues.map((f) => ({
              titre: f.titre,
              contenu: f.corps.length > CORPS_MAX ? `${f.corps.slice(0, CORPS_MAX)}...` : f.corps,
              url: f.sourceUrl,
            })),
          },
        };
      }

      // Aucun contact dans un bac à sable, et c'est la vérité : le dire permet d'éprouver ce que l'agent fait
      // face à un inconnu, qui est le cas le plus fréquent d'un premier message.
      case 'lire_contact':
        return { contenu: { connu: false } };

      // Terminer n'a aucun effet de bord : c'est le tour qui en tire les conséquences. On l'exécute donc
      // vraiment, et le panneau montre par quelle règle d'arrêt l'agent est sorti.
      case 'terminer': {
        const sortie = texte(args, 'sortie');
        if (sortie === '') return { ok: false, contenu: { erreur: 'parametre « sortie » manquant' }, erreur: 'sortie manquante' };
        return { contenu: { sortie }, sortie };
      }

      // ---------- Ceux qui AGISSENT, donc simulés ----------

      case 'poser_tag':
        return simule('la pose du tag', { tag: texte(args, 'tag') });
      case 'ecrire_variable':
        return simule('l ecriture du champ', { cle: texte(args, 'cle'), valeur: texte(args, 'valeur') });
      case 'envoyer_bloc':
        return simule('l envoi du bloc', { code: texte(args, 'code') });
      case 'escalader':
        // ⚠️ `rendu` n'est PAS posé : en production, il arrête le tour parce que la conversation est passée à
        // un humain. Ici il n'y a personne à qui la passer, et arrêter le tour empêcherait le client de voir
        // ce que son agent aurait dit ensuite. La simulation est signalée, le tour continue.
        return simule('le transfert vers un humain');

      default:
        return { ok: false, contenu: { erreur: `outil maison inconnu : ${handler || '(handler absent)'}` }, erreur: 'handler inconnu' };
    }
  };
}
