import { createHash } from 'node:crypto';
import type { EntrantRattache } from './rattachement';
import { lireJetonDeTest } from '../workflow/test-token';
import { messageDe } from '../lib/erreur';

/**
 * 🔴 Un jeton ne s'écrit jamais en clair dans les journaux : un jeton valide d'un autre espace est le secret
 * vivant d'un client, et un jeton refusé est presque toujours un secret voisin du vrai (faute de frappe).
 * L'empreinte, non réversible et stable, suffit à rapprocher deux lignes du journal.
 */
function empreinteJeton(jeton: string): string {
  return createHash('sha256').update(jeton).digest('hex').slice(0, 8);
}

/**
 * Déclenche un scénario en mode test quand le testeur envoie le jeton de son lien wa.me ou QR. Isolé dans le
 * handler, et exécuté avant l'avance de scénario et les automations : un jeton n'est ni une réponse à un
 * parcours ni un mot-clé. Les messages consommés ici sont signalés pour que les étapes suivantes les ignorent.
 */
export interface TestTokenDeps {
  /** Scénario portant ce jeton, avec son tenant (le jeton est unique globalement). null si inconnu. */
  findByTestToken(token: string): Promise<{ workflowId: string; tenantId: string } | null>;
  /**
   * Pas de garde « le fil appartient-il au scénario ? » : un jeton est un geste délibéré de qui tient le
   * téléphone, même quand l'agent de Meta tient le fil. L'exécuteur prend le fil (`ignoreHumanControl`) et refuse
   * lisiblement si Meta ne le rend pas.
   */
  /**
   * Marque la conversation comme un fil de test : elle sort de l'analyse (donc du push HubSpot) et des
   * statistiques, pour qu'un essai interne ne ressemble pas à un vrai client.
   */
  markConversationTest(tenantId: string, waId: string): Promise<void>;
  /**
   * Démarre le scénario ; le contact vient d'écrire, la fenêtre de 24 h est ouverte. `nodeId` = le bloc désigné
   * par le suffixe du jeton, `null` = l'entrée du scénario. `true` = parti ; `false` ou une chaîne (la raison) =
   * pas parti, et l'appelant journalise la raison.
   */
  startTestRun(tenantId: string, workflowId: string, waId: string, nodeId: string | null): Promise<boolean | string>;
}

/** Ce qu'on met d'un identifiant de bloc dans une trace : de quoi le reconnaître, jamais un message entier. */
const BLOC_TRACE_MAX = 80;
function extraitDeBloc(nodeId: string): string {
  return nodeId.length <= BLOC_TRACE_MAX ? nodeId : `${nodeId.slice(0, BLOC_TRACE_MAX)}… (${nodeId.length} caractères)`;
}

/** Traite les jetons de test d'un payload et rend les `messageId` consommés, à ignorer par les étapes suivantes. */
export async function processTestTokens(
  entrants: readonly EntrantRattache[],
  deps: TestTokenDeps,
  /**
   * 🔴 `messageId` déjà traités par une exécution précédente de ce webhook (redélivrance Meta, rejeu pg-boss) : sans
   * ce filtre, un rejeu relancerait le scénario et le client paierait deux fois les templates. Mieux vaut perdre
   * un test.
   */
  alreadySeen?: ReadonlySet<string>,
): Promise<Set<string>> {
  const consumed = new Set<string>();
  for (const { message: m, tenantId } of entrants) {
    // Filtre du chemin chaud : seuls les messages qui ressemblent à un jeton interrogent la base. Une seule lecture
    // (`lireJetonDeTest`) sert de filtre et d'extraction, pour qu'ils ne divergent pas. Une fois le jeton reconnu,
    // chaque refus est rare et se journalise ; avant, se taire est la seule option (ce filtre voit chaque message).
    const lu = lireJetonDeTest(m.body);
    if (!lu) continue;
    // Un jeton reçu en `standby` est traité : c'est justement le cas où l'agent de Meta tient le fil et où le
    // testeur a besoin qu'on le lui reprenne. Un entrant de client arrive bien en `standby` quand l'agent tient le
    // fil (les échos, eux, sont dans `message_echoes`). Rien d'autre ne change de canal : l'avance de scénario et
    // les automations refusent toujours le `standby`.
    if (m.field === 'standby') {
      // eslint-disable-next-line no-console
      console.log(`test-token: jeton reçu en « standby » (l'agent de Meta tient le fil pour ${m.waId}), le test va le lui reprendre`);
    }
    try {
      if (!tenantId) {
        // eslint-disable-next-line no-console
        console.warn(`test-token: jeton reçu sur le numéro ${m.phoneNumberId}, qui n'appartient à aucun espace connu (message ${m.messageId})`);
        continue;
      }
      // Le jeton seul, sans le suffixe de bloc, qui n'est pas stocké : chercher le texte entier ne trouverait rien.
      const wf = await deps.findByTestToken(lu.jeton);
      // 🔴 Jeton inconnu ou d'un autre client : rien ne se déclenche. C'est le numéro qui fait autorité sur le tenant,
      // un jeton fuité ne doit pas traverser les clients.
      if (!wf) {
        // eslint-disable-next-line no-console
        console.warn(`test-token: le jeton #${empreinteJeton(lu.jeton)} ne correspond à aucun scénario (message ${m.messageId})`);
        continue;
      }
      if (wf.tenantId !== tenantId) {
        // eslint-disable-next-line no-console
        console.warn(`test-token: le jeton #${empreinteJeton(lu.jeton)} appartient à un AUTRE espace que le numéro qui l'a reçu, rien n'est déclenché (message ${m.messageId})`);
        continue;
      }

      // Consommé ici, avant toute écriture et quoi qu'il arrive : ce message est un jeton de test, que l'avance de
      // scénario prendrait pour une réponse et les automations pour un mot-clé.
      consumed.add(m.messageId);

      // Rejeu du même message : tout a déjà été fait au premier passage. On garde la consommation (le message
      // reste un jeton) mais on ne relance rien.
      if (alreadySeen?.has(m.messageId)) continue;

      await deps.markConversationTest(tenantId, m.waId);
      // La fermeture du parcours en cours se fait dans `runFrom` (`closeActiveByWaId`), après les gardes de
      // l'exécuteur : un test qui ne démarre pas ne tue pas le parcours, et un parcours endormi est fermé aussi.
      // Un refus se journalise : un lien permanent peut désigner un bloc supprimé depuis, que l'exécuteur refuse.
      const issue = await deps.startTestRun(tenantId, wf.workflowId, m.waId, lu.nodeId);
      if (issue !== true) {
        // eslint-disable-next-line no-console
        // Le bloc est tronqué dans la trace : le suffixe n'a pas de forme imposée, donc sa longueur n'est bornée
        // par rien.
        console.warn(`test-token: test NON démarré pour ${m.waId} sur le scénario ${wf.workflowId}${lu.nodeId ? ` au bloc ${extraitDeBloc(lu.nodeId)}` : ''} : ${issue === false ? 'refus sans raison' : issue}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('processTestTokens: jeton ignoré:', messageDe(err));
    }
  }
  return consumed;
}
