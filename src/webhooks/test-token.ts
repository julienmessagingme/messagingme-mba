import { extractInbound } from './inbound';
import { looksLikeTestToken, normalizeTestToken } from '../workflow/test-token';

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
   * Le scénario a-t-il le droit d'écrire dans ce fil (`control_owner = app_workflow`) ? Vérifié AVANT toute
   * écriture : la même garde existe plus bas dans l'exécuteur, mais elle n'agirait qu'après avoir déjà marqué
   * la conversation et clos le parcours en attente, c'est-à-dire après avoir cassé un état sans rien démarrer.
   */
  mayStart(tenantId: string, waId: string): Promise<boolean>;
  /**
   * Marque la conversation comme un fil de TEST : elle sort de l'analyse (donc du push HubSpot) et des
   * statistiques, pour qu'un essai interne ne ressemble pas à un vrai client dans le tableau de bord.
   */
  markConversationTest(tenantId: string, waId: string): Promise<void>;
  /**
   * Termine le parcours éventuellement en attente pour ce contact. Un testeur qui relance son lien veut
   * repartir du début : sans ça, un run resté en attente d'une réponse resterait orphelin à vie.
   */
  endWaitingRun(tenantId: string, waId: string): Promise<void>;
  /** Démarre le scénario depuis son entrée. Le contact vient d'écrire, la fenêtre 24 h est donc ouverte. */
  startTestRun(tenantId: string, workflowId: string, waId: string): Promise<boolean>;
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
    if (m.field && m.field !== 'messages') continue; // standby : le MBA tient le fil
    // Filtre du chemin chaud : seuls les messages qui RESSEMBLENT à un jeton interrogent la base. Un message
    // client ordinaire ne coûte donc rien de plus qu'avant.
    if (!looksLikeTestToken(m.body)) continue;
    try {
      const tenantId = await deps.phoneNumberTenant(m.phoneNumberId);
      if (!tenantId) continue;
      const wf = await deps.findByTestToken(normalizeTestToken(m.body));
      // Jeton inconnu, ou appartenant à un AUTRE client : on ne déclenche rien. Le jeton désigne le scénario,
      // mais c'est le numéro qui fait autorité sur le tenant ; un jeton fuité ne doit pas traverser les clients.
      if (!wf || wf.tenantId !== tenantId) continue;

      // CONSOMMÉ ici, AVANT toute écriture et quoi qu'il arrive ensuite : ce message EST un jeton de test.
      // Le rendre à l'avance de scénario le ferait interpréter comme une réponse du contact, et aux
      // automations comme un mot-clé. Placé plus bas, un échec intermédiaire rouvrait ces deux portes.
      consumed.add(m.messageId);

      // Rejeu du même message : tout a déjà été fait au premier passage. On garde la consommation (le message
      // reste un jeton) mais on ne relance rien.
      if (alreadySeen?.has(m.messageId)) continue;

      // Le fil appartient-il encore au scénario ? Un opérateur (ou MBA) qui tient la conversation a la
      // priorité. On le vérifie AVANT d'écrire : sinon on marquerait le fil et on clorait son parcours en
      // attente pour finalement ne rien démarrer, en silence.
      if (!(await deps.mayStart(tenantId, m.waId))) {
        // eslint-disable-next-line no-console
        console.log(`test-token: fil ${m.waId} tenu par un humain ou par MBA, test non démarré`);
        continue;
      }

      await deps.markConversationTest(tenantId, m.waId);
      await deps.endWaitingRun(tenantId, m.waId);
      await deps.startTestRun(tenantId, wf.workflowId, m.waId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('processTestTokens: jeton ignoré:', err instanceof Error ? err.message : err);
    }
  }
  return consumed;
}
