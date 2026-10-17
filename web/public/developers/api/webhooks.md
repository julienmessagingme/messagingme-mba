<!-- Version Markdown de https://console.messagingme.app/developers/api/webhooks, générée depuis la page (npm run doc:md). English: https://console.messagingme.app/developers/api/webhooks.en.md -->

# Webhooks sortants

Votre application reçoit en direct ce qui se passe sur WhatsApp : chaque événement part en POST vers l’adresse que vous inscrivez, signé et horodaté. Les adresses se gèrent dans [Developers > Webhooks sortants](https://console.messagingme.app/developers/evenements), ou depuis Claude Code par l’outil MCP create_webhook_endpoint.

<a id="enveloppe"></a>

## L’enveloppe

Le même format pour tous les événements : seul data change selon type.

_Corps reçu_

```
{
  "id": "evt_5f0c2b9e8d7a4c1b9e3f6a2d4c8b1e07",
  "type": "message.received",
  "created_at": "2026-10-08T14:03:11.000Z",
  "workspace_id": "3f2a9c1e-…",
  "data": {
    "contact": {
      "id": "8b1e07c4-…",
      "phone": "+33612345678",
      "name": "Claire",
      "external_id": null,
      "opted_out": {
        "whatsapp": false,
        "rcs": false
      }
    },
    "channel": "whatsapp",
    "message_id": "wamid.…",
    "message_type": "text",
    "text": "Bonjour, où en est ma commande ?",
    "transcription": null,
    "button": null
  }
}
```

- id est stable : le même au réessai et au rejeu. Gardez les id déjà traités pour ignorer un doublon (la livraison est « au moins une fois »).
- Aucun ordre n’est garanti entre deux événements : un message lu peut arriver avant le message livré.
- Le contenu est figé au moment de l’événement : un réessai renvoie exactement le même corps.

<a id="signature"></a>

## Vérifier la signature

Le format est celui de Standard Webhooks : trois en-têtes, `webhook-id`, `webhook-timestamp`, `webhook-signature`, et une signature HMAC-SHA256 de `id.timestamp.corps` avec la clé qui suit whsec_ dans votre secret. Les bibliothèques Standard Webhooks de tous les langages la vérifient telles quelles.

_Vérification en Node.js_

```
import crypto from 'node:crypto';

// Le corps BRUT reçu (une chaîne), jamais l’objet déjà analysé : la signature porte sur ces octets-là.
export function verifier(corpsBrut, entetes, secret = process.env.MESSAGINGME_WEBHOOK_SECRET) {
  const id = entetes['webhook-id'];
  const horodatage = entetes['webhook-timestamp'];
  // Refuser un envoi de plus de 5 minutes : un rejeu d’un message intercepté ne passe pas.
  if (Math.abs(Date.now() / 1000 - Number(horodatage)) > 300) return false;
  const cle = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const attendue = crypto.createHmac('sha256', cle).update(id + '.' + horodatage + '.' + corpsBrut).digest('base64');
  // Plusieurs signatures pendant une rotation du secret, séparées par une espace : une seule suffit.
  return entetes['webhook-signature'].split(' ').some((s) => {
    const [version, valeur] = s.split(',');
    return version === 'v1' && valeur.length === attendue.length
      && crypto.timingSafeEqual(Buffer.from(valeur), Buffer.from(attendue));
  });
}
```

> **Obligatoire**
>
> Rangez le secret dans une variable d’environnement de votre application, jamais dans le code ni dans un fichier suivi par git. Il n’est montré qu’une fois ; un secret perdu se renouvelle (l’ancien signe encore 24 h).

<a id="reessais"></a>

## Réponse et réessais

- Répondez 2xx dans les 10 secondes : l’événement est livré. Traitez le travail long après avoir répondu.
- Toute autre réponse, ou aucune, fait réessayer : 30 s, 2 min, 10 min, 30 min, puis toutes les heures, pendant 24 h.
- 410 Gone arrête les réessais de cet événement. Les redirections ne sont pas suivies.
- Chaque envoi se lit dans le journal de l’adresse (corps envoyé, réponse, tentatives) et se rejoue d’un clic.

<a id="types"></a>

## Les événements

Chaque adresse choisit ses types. Les accusés de livraison sont décochés par défaut : une campagne en produit jusqu’à trois par destinataire.

| Type | Quand | Champs de data |
| --- | --- | --- |
| `message.received` | Un contact vous écrit (texte, bouton tapé, média, réponse de formulaire). | contact, channel, message_id, message_type, text, transcription, button |
| `message.delivered` | Meta confirme la livraison d’un de vos messages. (décoché par défaut) | contact, channel, message_id, origin, send_id |
| `message.read` | Le contact a lu un de vos messages. (décoché par défaut) | contact, channel, message_id, origin, send_id |
| `message.failed` | Un de vos messages n’a pas pu être livré. (décoché par défaut) | contact, channel, message_id, origin, send_id, reason, meta_code |
| `link.clicked` | Le contact a cliqué un lien suivi. | contact, link, template, destination |
| `contact.opted_out` | Le contact s’est désabonné (STOP, fiche, action en masse, API). | contact, channel, source |
| `conversation.analyzed` | L’analyse d’une conversation est prête (offres Pro et Entreprise). | contact, conversation_id, intent, sentiment, satisfaction, urgency, resolved, topic, action_suggestion, handled_by, exchanges_count, summary |
| `contact.risk_changed` | Le risque de désengagement d’un contact a changé de niveau (calcul de nuit). | contact, level, previous_level, score, reasons |
| `template.status_changed` | Meta a tranché sur un de vos modèles (approuvé, refusé, en pause, désactivé). Aucune donnée de contact. | template, status, reason |
| `agent.action` | Un agent IA a déclenché une de vos actions en pleine conversation (une fois par jour, par contact et par action) : les champs recueillis sont dans fields. (décoché par défaut) | contact, conversation_id, agent, action, fields, channel |
| `conversation.needs_reply` | Mode « mon application répond » : un message attend la réponse de votre application, à l’adresse désignée par le répondeur. | contact, conversation_id, channel, message_id, message_type, text, transcription, reply_with |
| `test` | Le bouton « Envoyer un essai », ou l’outil MCP send_test_event. | message |

Le contact porte son id, son numéro (phone), son nom, son identifiant externe et ses désabonnements.

<a id="repondre"></a>

## Mon application répond

Désignez une adresse dans « Qui répond au client » (Accueil), ou par l’outil MCP set_default_responder en mode application : chaque message que personne ne tient lui arrive en `conversation.needs_reply`, sans abonnement à cocher, devant les autres envois. Votre application répond par l’API, avec la clé d’API de l’espace :

_POST /v1/messages/whatsapp_

```
{
  "contactId": "8b1e07c4-…",
  "text": "Bonjour Claire, votre commande part demain."
}
```

- Répondez 2xx tout de suite au webhook, puis envoyez la réponse : la conversation reste à votre application, hors de la file « À traiter » de l’équipe.
- La fenêtre de 24 h s’applique : la réponse part tant que le client a écrit dans les 24 dernières heures.
- Répondez à conversation.needs_reply seulement : si l’adresse reçoit aussi message.received, le même message y arrive deux fois, et une réponse aux deux partirait deux fois. La clé d’API doit porter le droit sends:create.
- Ces réponses ne comptent dans aucun quota quotidien de l’API ; le plafond par minute s’applique.
- Aucun repli : si votre application ne répond pas, personne ne le fait à sa place. Une adresse en pause, supprimée ou au-delà de votre offre rend les messages à l’équipe.
