import { extractInbound } from './inbound';
import { lireJetonDeTest } from '../workflow/test-token';

/**
 * Déclenche un scénario en MODE TEST quand le testeur envoie le jeton de son lien wa.me / QR (Lot F).
 *
 * ISOLÉ dans le handler (ne doit jamais faire échouer le job webhook partagé), et exécuté AVANT l'avance de
 * scénario et les automations : un jeton de test n'est pas une réponse à un parcours en cours, ni un mot-clé
 * ordinaire. Les messages consommés ici sont signalés à l'appelant pour que les étapes suivantes les ignorent,
 * sinon le même message servirait deux fois (test + avance, ou test + automation).
 */
export interface TestTokenDeps {
  /** Tenant propriétaire du numéro business. null si inconnu. */
  phoneNumberTenant(phoneNumberId: string): Promise<string | null>;
  /** Scénario portant ce jeton, avec son tenant (le jeton est unique globalement). null si inconnu. */
  findByTestToken(token: string): Promise<{ workflowId: string; tenantId: string } | null>;
  /**
   * ⚠️ IL N'Y A PLUS DE GARDE `mayStart` ICI, ET C'EST UNE DÉCISION DE JULIEN (2026-09-16, après son essai
   * réel). Elle refusait de démarrer dès que le fil n'appartenait pas au scénario, donc en particulier quand
   * l'agent de Meta le tenait : « quand y a un jeton, le MBA ne marche pas ». Un jeton de test est un geste
   * DÉLIBÉRÉ de quelqu'un qui tient le téléphone ; le cas « un opérateur répond au type qui est en train de
   * tester » n'existe pas. La prise du fil est faite par l'exécuteur (`ignoreHumanControl`), qui la refuse
   * lisiblement si Meta refuse de rendre la main.
   */
  /**
   * Marque la conversation comme un fil de TEST : elle sort de l'analyse (donc du push HubSpot) et des
   * statistiques, pour qu'un essai interne ne ressemble pas à un vrai client dans le tableau de bord.
   */
  markConversationTest(tenantId: string, waId: string): Promise<void>;
  /**
   * Termine le parcours éventuellement en attente pour ce contact. Un testeur qui relance son lien veut
   * repartir du début : sans ça, un run resté en attente d'une réponse resterait orphelin à vie.
   */
  /**
   * Démarre le scénario. Le contact vient d'écrire, la fenêtre 24 h est donc ouverte.
   *
   * `nodeId` = le BLOC désigné par le suffixe du jeton (2026-09-16), `null` = l'entrée du scénario, c'est-à-dire
   * le comportement de tous les liens déjà distribués.
   *
   * true = parti ; `false` ou une chaîne (la raison) = pas parti, et la raison est JOURNALISÉE par l'appelant.
   */
  startTestRun(tenantId: string, workflowId: string, waId: string, nodeId: string | null): Promise<boolean | string>;
}

/** Ce qu'on met d'un identifiant de bloc dans une trace : de quoi le reconnaître, jamais un message entier. */
const BLOC_TRACE_MAX = 80;
function extraitDeBloc(nodeId: string): string {
  return nodeId.length <= BLOC_TRACE_MAX ? nodeId : `${nodeId.slice(0, BLOC_TRACE_MAX)}… (${nodeId.length} caractères)`;
}

/**
 * Traite les jetons de test d'un payload. Renvoie les `messageId` CONSOMMÉS (à ignorer par les étapes
 * suivantes du même webhook).
 */
export async function processTestTokens(
  payload: unknown,
  deps: TestTokenDeps,
  /**
   * `messageId` DÉJÀ traités par une exécution précédente de ce webhook (Meta redélivre, pg-boss rejoue).
   * Sans ce filtre, un rejeu relancerait le scénario depuis le début : le testeur recevrait deux fois la
   * séquence et le client paierait deux fois les templates. On préfère perdre un test que doubler un envoi.
   */
  alreadySeen?: ReadonlySet<string>,
): Promise<Set<string>> {
  const consumed = new Set<string>();
  for (const m of extractInbound(payload)) {
    // Filtre du chemin chaud : seuls les messages qui RESSEMBLENT à un jeton interrogent la base. Un message
    // client ordinaire ne coûte donc rien de plus qu'avant.
    //
    // ⚠️ UNE SEULE LECTURE, ET C'EST VOULU. Le filtre et l'extraction étaient deux appels (`looksLikeTestToken`
    // puis `normalizeTestToken`) : deux occasions de diverger sur la forme acceptée. `lireJetonDeTest` rend les
    // deux d'un coup, donc ce qui a passé le filtre est exactement ce qu'on lit.
    //
    // 🔴 ET IL EST LU AVANT TOUTE AUTRE GARDE, POUR QUE LES AUTRES PUISSENT PARLER. C'est la leçon de l'essai
    // réel du 2026-09-16 : Julien a scanné son QR, l'agent de Meta a répondu à sa place, et ce chemin n'a
    // laissé AUCUNE trace. Il avait quatre sorties muettes, et il était impossible de dire laquelle avait
    // servi : le parcours n'existait pas, la conversation n'était pas marquée, les journaux étaient vides.
    // Une fois qu'on SAIT que le texte est un jeton, chaque refus est rare et mérite d'être dit ; avant de le
    // savoir, se taire est la seule option tenable (ce filtre voit chaque message de chaque client).
    const lu = lireJetonDeTest(m.body);
    if (!lu) continue;
    if (m.field && m.field !== 'messages') {
      // eslint-disable-next-line no-console
      console.warn(`test-token: jeton reçu sur le canal « ${m.field} » et non « messages », rien n'est déclenché (message ${m.messageId})`);
      continue;
    }
    try {
      const tenantId = await deps.phoneNumberTenant(m.phoneNumberId);
      if (!tenantId) {
        // eslint-disable-next-line no-console
        console.warn(`test-token: jeton reçu sur le numéro ${m.phoneNumberId}, qui n'appartient à aucun espace connu (message ${m.messageId})`);
        continue;
      }
      // 🔴 LE JETON SEUL, SANS LE SUFFIXE DE BLOC. Le suffixe n'est pas stocké : chercher le texte entier ne
      // trouverait jamais rien, et le test ne démarrerait pas du tout.
      const wf = await deps.findByTestToken(lu.jeton);
      // Jeton inconnu, ou appartenant à un AUTRE client : on ne déclenche rien. Le jeton désigne le scénario,
      // mais c'est le numéro qui fait autorité sur le tenant ; un jeton fuité ne doit pas traverser les clients.
      if (!wf) {
        // eslint-disable-next-line no-console
        console.warn(`test-token: le jeton ${lu.jeton} ne correspond à aucun scénario (message ${m.messageId})`);
        continue;
      }
      if (wf.tenantId !== tenantId) {
        // eslint-disable-next-line no-console
        console.warn(`test-token: le jeton ${lu.jeton} appartient à un AUTRE espace que le numéro qui l'a reçu, rien n'est déclenché (message ${m.messageId})`);
        continue;
      }

      // CONSOMMÉ ici, AVANT toute écriture et quoi qu'il arrive ensuite : ce message EST un jeton de test.
      // Le rendre à l'avance de scénario le ferait interpréter comme une réponse du contact, et aux
      // automations comme un mot-clé. Placé plus bas, un échec intermédiaire rouvrait ces deux portes.
      consumed.add(m.messageId);

      // Rejeu du même message : tout a déjà été fait au premier passage. On garde la consommation (le message
      // reste un jeton) mais on ne relance rien.
      if (alreadySeen?.has(m.messageId)) continue;

      await deps.markConversationTest(tenantId, m.waId);
      // ⚠️ LA FERMETURE DU PARCOURS EN COURS N'EST PLUS ICI. Elle y était (`endWaitingRun`) et elle avait
      // deux défauts que le passage par `runFrom` supprime : elle tirait AVANT les gardes de l'exécuteur,
      // donc elle pouvait tuer un parcours pour un test qui n'allait pas démarrer (scénario vide, fil tenu) ;
      // et elle ne voyait que `waiting`, laissant vivre un parcours ENDORMI qui se serait réveillé par-dessus
      // le test. `closeActiveByWaId` couvre les deux statuts et efface l'échéance.
      // 🔴 LE REFUS EST JOURNALISÉ, parce qu'un chemin qui décide de NE PAS agir doit le dire. Le résultat
      // était jeté : un test qui ne partait pas ne laissait AUCUNE trace, ni en base ni dans les journaux, et
      // le testeur ne voyait qu'un silence. C'est le défaut relevé sur le gel d'avance le 2026-09-14, et le
      // lien PERMANENT le rend ordinaire : un lien collé il y a trois semaines peut désigner un bloc supprimé
      // depuis, et l'exécuteur le refuse alors avec sa raison.
      const issue = await deps.startTestRun(tenantId, wf.workflowId, m.waId, lu.nodeId);
      if (issue !== true) {
        // eslint-disable-next-line no-console
        // ⚠️ LE BLOC EST TRONQUÉ DANS LA TRACE. Le suffixe n'a plus de forme imposée (c'est ce qui évite
        // qu'un identifiant inattendu fuie jusqu'à l'agent de Meta), donc sa LONGUEUR n'est bornée par rien :
        // le recopier tel quel mettrait un message entier dans une ligne de journal.
        console.warn(`test-token: test NON démarré pour ${m.waId} sur le scénario ${wf.workflowId}${lu.nodeId ? ` au bloc ${extraitDeBloc(lu.nodeId)}` : ''} : ${issue === false ? 'refus sans raison' : issue}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('processTestTokens: jeton ignoré:', err instanceof Error ? err.message : err);
    }
  }
  return consumed;
}
