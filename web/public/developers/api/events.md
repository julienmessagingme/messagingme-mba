<!-- Version Markdown de https://console.messagingme.app/developers/api/events, générée depuis la page (npm run doc:md). English: https://console.messagingme.app/developers/api/events.en.md -->

# Événements

<a id="signaux"></a>

## Ce que la console remonte

Quand il se passe quelque chose sur une fiche, la console pousse un événement, avec l’état courant de la fiche, vers l’outil que votre administrateur a branché dans Paramètres > Intégrations.

- Seuls les outils proposés dans Paramètres > Intégrations les reçoivent : ce n’est pas un webhook vers une adresse de votre choix.
- Les noms commencent par `em_`, et ne changent pas d’un outil à l’autre, ceux des champs non plus. Un texte fait 300 caractères au plus ; une valeur absente ou vide n’est pas envoyée.
- Le profil est désigné par votre identifiant, `externalId` : une fiche qui n’en porte pas n’est pas remontée (l’écran du réglage compte ces signaux). Passez-le à chaque appel : fiche, envoi, message.
- Un même événement peut arriver deux fois : dédupliquez sur `em_event_id`, stable.

> **Attention**
>
> Le texte d’un message n’est jamais remonté. Le résumé d’une conversation ne l’est que si l’option est activée dans le réglage : il contient des propos du client.

## Délais

- Moins d’une minute en temps normal. Chaque événement porte l’heure où il s’est produit, pas celle où il arrive.
- Derrière une campagne de plusieurs milliers de destinataires, les accusés de livraison et de lecture peuvent arriver avec plusieurs dizaines de minutes de retard. Les réponses, clics, désabonnements et conversations analysées ne sont pas retardés.
- « À la fin d’une conversation » : après 25 minutes sans message, puis le passage de l’analyse, toutes les 5 minutes. Comptez environ une demi-heure après le dernier message : assez pour une relance, pas pour une alerte immédiate.
- Après une panne de plus de 24 heures, selon l’outil, un événement en attente peut ne pas partir. Seul part alors l’état de la fiche relu au moment de l’envoi (son identifiant, ses désabonnements, sa dernière analyse) ; jamais ce que l’événement seul apprenait (dernière réponse, joignabilité RCS), qui écraserait un état plus récent.

## Les événements

Valeurs de `origine` : `humain`, `scenario`, `ia`, `mba`, `campagne`, `mcp`, `api` ; de `canal` : `whatsapp`, `rcs`. Une note absente (satisfaction, urgence) veut dire « pas de mesure » : elle n’écrase jamais la précédente.

| Événement | Quand | Champs |
| --- | --- | --- |
| `em_message_delivered` | Dans la minute ; en retard derrière une grosse campagne | `canal` `origine` `send_id` : send_id : l’envoi (sendId) auquel le message appartient, seulement s’il appartient à un envoi |
| `em_message_read` | Dans la minute ; en retard derrière une grosse campagne | `canal` `origine` `send_id` : Mêmes champs que la livraison |
| `em_message_failed` | Dans la minute ; en retard derrière une grosse campagne | `canal` `origine` `send_id` `motif` `code_meta` : motif : la raison de l’échec, quand elle est connue. code_meta : le code d’erreur de Meta, pour un message WhatsApp |
| `em_replied` | Dans la minute, même pendant une grosse campagne | `canal` `bouton` : bouton : le libellé du bouton tapé. Jamais le texte du message. Une réaction (emoji) n’est pas une réponse. |
| `em_link_clicked` | Dans la minute, même pendant une grosse campagne | `lien` `template` `destination` : lien : le code du lien suivi. Seulement quand le clic est attribué à une fiche ; un clic automatique (aperçu, robot) ne compte pas. destination : l’adresse vers laquelle le lien mène, absente au-delà de 300 caractères (une adresse coupée serait fausse). |
| `em_opted_out` | Dans la minute, même pendant une grosse campagne | `canal` `source` : canal : seulement quand la personne a écrit STOP sur ce canal ; absent pour un désabonnement posé par votre équipe ou par l’API. source : d’où vient le refus (whatsapp_stop, rcs_stop, crm, api…). |
| `em_conversation_analyzed` | À la fin d’une conversation | `intent` `sentiment` `satisfaction` `urgence` `resolved` `topic` `action_suggestion` `handled_by` `exchanges_count` `summary_1` `summary_2` `summary_3` : summary_1 à summary_3 : le résumé, seulement si l’option est activée, en morceaux de 300 caractères au plus, à recoller bout à bout sans séparateur (les derniers sont absents quand il est court). |
| `em_risk_changed` | Chaque nuit, quand le niveau change | `niveau` `ancien_niveau` `score` `raisons` : niveau et ancien_niveau : inconnu, faible, moyen ou eleve. raisons : jusqu’à trois codes séparés par des virgules (silence_60j, silence_30j, sans_reponse, non_lu, reclamation, negatif, insatisfait, injoignable, stop, bloque). |

## Les attributs de la fiche

| Attribut de la fiche | Sens |
| --- | --- |
| `em_contact_id` | L’identifiant de la fiche (contactId), pour la désigner sans ambiguïté dans un appel à l’API |
| `em_last_intent` | L’intention de la dernière conversation analysée (mêmes valeurs que l’écran d’analyse) |
| `em_last_sentiment` | Le sentiment de la dernière conversation analysée |
| `em_satisfaction` | La satisfaction, de 0 à 10. Absente d’une analyse, elle n’écrase pas la précédente |
| `em_urgency` | L’urgence, de 0 à 10, même règle |
| `em_last_resolved` | La dernière conversation analysée est-elle résolue ? |
| `em_last_topic` | Le sujet de la dernière conversation analysée, en clair |
| `em_last_handled_by` | Qui l’a traitée : humain, automatise ou mba (l’agent de Meta) |
| `em_last_action_suggestion` | L’action que l’analyse suggère : creer_devis, rappeler, relancer, escalader ou aucune |
| `em_last_reply_at` | La date de la dernière réponse du contact |
| `em_whatsapp_optout` | Le contact est-il désabonné ? |
| `em_rcs_optout` | A-t-il dit STOP sur le canal RCS ? |
| `em_rcs_reachable` | Le dernier message RCS lui a-t-il été délivré ? |
| `em_risk_level` | Le risque de désengagement : inconnu, faible, moyen ou eleve, recalculé chaque nuit |
| `em_risk_score` | Le score de risque, de 0 à 100 (absent quand le niveau est inconnu) |
| `em_risk_reasons` | Les raisons principales du niveau, jusqu’à trois codes séparés par des virgules |
