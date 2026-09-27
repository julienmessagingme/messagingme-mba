export interface WebhooksMuetsDeps {
  ops: {
    /**
     * Combien de webhooks Meta ont été reçus sur la fenêtre (jobs enfilés par le receveur). Les reçus et pas les
     * traités : le receveur enfile sans rien interpréter, ce compteur ne dépend d'aucune des couches surveillées.
     */
    webhooksRecusDepuis(fenetreMinutes: number): Promise<number>;
    /** Combien d'événements ont été enregistrés sur la même fenêtre (`webhook_events`). */
    evenementsWebhookDepuis(fenetreMinutes: number): Promise<number>;
  };
  alert: (msg: string) => void;
  /**
   * En dessous de ce nombre de reçus, on ne conclut rien : deux webhooks sans enregistrement peuvent être deux
   * redélivrances déjà connues.
   */
  seuil?: number;
  fenetreMinutes?: number;
}

const SEUIL_DEFAUT = 5;
const FENETRE_DEFAUT = 60;

/**
 * Surveille le cas « les webhooks arrivent, mais plus rien ne s'écrit ».
 *
 * Un extracteur qui ne trouve rien rend un tableau vide, pas une erreur : les jobs réussissent, `/health`
 * répond 200, et pourtant rien ne s'enregistre. Comparer messages parsés et enregistrés ne voit rien (les deux
 * valent zéro) ; seul l'écart entre webhooks reçus (enfilés avant toute interprétation) et événements
 * enregistrés trahit la panne.
 *
 * On alerte sur l'entrée en silence, pas sur l'état (même doctrine que `dlq-sweep`), et on réarme quand
 * l'écriture repart. Limite : seul le silence total est vu, pas la perte d'un seul type de message.
 */
export function creerWebhooksMuetsSweep(deps: WebhooksMuetsDeps): () => Promise<boolean> {
  const seuil = deps.seuil ?? SEUIL_DEFAUT;
  const fenetre = deps.fenetreMinutes ?? FENETRE_DEFAUT;
  let dejaAlerte = false;
  let enCours = false;

  return async function webhooksMuetsSweep(): Promise<boolean> {
    // Garde de ré-entrance, comme `dlq-sweep` : deux passes qui se chevauchent alerteraient deux fois.
    if (enCours) return false;
    enCours = true;
    try {
      return await passe();
    } finally {
      enCours = false;
    }
  };

  async function passe(): Promise<boolean> {
    const recus = await deps.ops.webhooksRecusDepuis(fenetre);
    // Trafic trop faible pour conclure. On ne réarme pas : un creux de trafic au milieu d'une panne ne doit pas
    // faire réalerter dès que le trafic reprend.
    if (recus < seuil) return false;

    const enregistres = await deps.ops.evenementsWebhookDepuis(fenetre);
    if (enregistres > 0) {
      dejaAlerte = false; // l'écriture fonctionne : on réarme pour la prochaine fois.
      return false;
    }
    if (dejaAlerte) return false;
    dejaAlerte = true;
    deps.alert(
      `${recus} webhook(s) Meta reçu(s) en ${fenetre} min et AUCUN événement enregistré. `
      + 'Les messages entrants sont probablement perdus : vérifier la forme des payloads (cf. src/webhooks/change.ts).',
    );
    return true;
  }
}
