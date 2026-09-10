export interface WebhooksMuetsDeps {
  /**
   * Combien de webhooks Meta ont été REÇUS sur la fenêtre (jobs enfilés par le receveur).
   *
   * ⚠️ C'est bien le nombre de REÇUS qu'il faut, pas de traités : le receveur enfile sans rien interpréter,
   * donc ce compteur est le seul qui ne dépende d'AUCUNE des couches qu'on surveille.
   */
  recus(fenetreMinutes: number): Promise<number>;
  /** Combien d'événements ont été ENREGISTRÉS sur la même fenêtre (`webhook_events`). */
  enregistres(fenetreMinutes: number): Promise<number>;
  alert: (msg: string) => void;
  /**
   * En dessous de ce nombre de webhooks reçus, on ne conclut RIEN : sur un parc calme, deux webhooks sans
   * enregistrement peuvent être deux redélivrances déjà connues, ce qui est normal.
   */
  seuil?: number;
  fenetreMinutes?: number;
}

const SEUIL_DEFAUT = 5;
const FENETRE_DEFAUT = 60;

/**
 * Surveille le cas « les webhooks arrivent, mais plus rien ne s'écrit ».
 *
 * 🔴 CE BALAYAGE EXISTE PARCE QUE TOUT CE QU'ON SURVEILLAIT DISAIT « VERT » PENDANT DEUX JOURS DE PANNE
 * (2026-09-08 au 2026-09-10). L'agent de Meta répondait aux clients à notre place et nous n'enregistrions
 * plus RIEN, ni message entrant ni accusé de livraison. Or : UptimeRobot était vert, `/health` répondait 200,
 * les conteneurs étaient `healthy`, et les jobs de la file se terminaient « avec succès ». Ils se terminaient
 * en succès parce qu'un extracteur qui ne trouve rien rend un tableau vide, ce qui n'est pas une erreur.
 *
 * ⚠️ LA LEÇON GÉNÉRALE, ET C'EST ELLE QU'IL FAUT GARDER : nos sondes vérifiaient qu'un service RÉPOND, aucune
 * ne vérifiait qu'il ENREGISTRE. Un succès technique n'est pas une preuve d'effet. Le même piège a déjà coûté
 * cher ailleurs dans le parc (le `send-node` de MessagingMe répond `ok` sur un node inexistant).
 *
 * 🔴 POURQUOI COMPARER LES REÇUS AUX ENREGISTRÉS, ET PAS LES MESSAGES AUX MESSAGES. Pendant la panne, le
 * parseur ne produisait AUCUN événement : `webhook_events` était donc vide, exactement comme s'il n'était rien
 * arrivé. Une sonde qui aurait comparé « messages parsés » à « messages enregistrés » n'aurait rien vu, les
 * deux valant zéro. Le seul chiffre qui restait vrai était le nombre de webhooks REÇUS, que le receveur
 * enfile avant toute interprétation. C'est l'écart entre ces deux-là qui trahit la panne : 58 reçus, 0
 * enregistrés.
 *
 * ⚠️ ALERTE SUR L'ENTRÉE EN SILENCE, PAS SUR L'ÉTAT, même doctrine que `dlq-sweep`. Une panne d'écriture dure
 * tant que personne ne la corrige : réalerter à chaque passe enverrait un Telegram toutes les cinq minutes à
 * vie, et une alerte permanente est une alerte qu'on cesse de lire. On réarme quand l'écriture repart, donc
 * une rechute réalerte.
 *
 * ⚠️ CE QU'IL NE VOIT PAS, ET IL FAUT LE SAVOIR : il détecte le silence TOTAL. Si demain seuls les messages
 * vocaux se perdent pendant que le reste s'enregistre, ce balayage restera muet. Le couvrir demanderait de
 * comparer par TYPE, ce qui n'est pas fait ici.
 */
export function creerWebhooksMuetsSweep(deps: WebhooksMuetsDeps): () => Promise<boolean> {
  const seuil = deps.seuil ?? SEUIL_DEFAUT;
  const fenetre = deps.fenetreMinutes ?? FENETRE_DEFAUT;
  let dejaAlerte = false;
  let enCours = false;

  return async function webhooksMuetsSweep(): Promise<boolean> {
    // Garde de ré-entrance, comme `dlq-sweep` : `setInterval` n'attend pas la passe précédente, et deux
    // passes qui se chevauchent liraient `dejaAlerte` avant que l'une l'ait mis à jour, donc alerteraient
    // deux fois sur le même silence.
    if (enCours) return false;
    enCours = true;
    try {
      return await passe();
    } finally {
      enCours = false;
    }
  };

  async function passe(): Promise<boolean> {
    const recus = await deps.recus(fenetre);
    // Trafic trop faible pour conclure. On NE réarme pas ici : un creux de trafic au milieu d'une panne ne
    // doit pas faire réalerter dès que le trafic reprend, la panne, elle, n'a pas bougé.
    if (recus < seuil) return false;

    const enregistres = await deps.enregistres(fenetre);
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
