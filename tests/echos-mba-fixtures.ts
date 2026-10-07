/**
 * LES ÉCHOS DES MESSAGES INTERACTIFS DE L'AGENT DE META, ET LES CLICS QUI EN REVIENNENT, tels que Meta les envoie.
 *
 * Relevés le 2026-10-07 sur le numéro de test (T0 du plan `docs/superpowers/plans/2026-10-07-messages-interactifs.md`) :
 * neuf messages interactifs créés sur l'agent, déclenchés depuis un vrai téléphone, puis lus dans `webhook_events`.
 * Rien n'est inventé ici, seuls les numéros, les `wamid` (ils encodent le numéro en base64), les horodatages et la
 * réponse au formulaire sont remplacés par des valeurs fictives.
 *
 * `ECHOS_MBA` : ce que `webhook_events` garde d'un écho (`source = 'standby'`), soit `{id, message, timestamp}`, le corps
 * sous `message`. Ce que la mesure a appris et qu'aucune doc ne dit :
 *  - le corps reprend la forme d'ENVOI de la Cloud API ;
 *  - un formulaire part en `interactive.type = 'galaxy_message'`, jamais `flow` ;
 *  - une demande de position part en `location_request_message`, un lieu en `type: 'location'` à plat, coordonnées en chaînes ;
 *  - les identifiants des boutons sont fabriqués par Meta (`biz_ai_qr_0`), ceux des lignes préfixés (`biz_ai_list_`) ;
 *  - chaque composant est PRÉCÉDÉ d'un écho texte d'accompagnement, parfois en anglais (`phraseAvantLeComposantEnAnglais`).
 *
 * `CLICS_MBA` : le message entrant qui revient (`source = 'messages'`). Le clic sur une carte d'un carrousel à réponses
 * arrive en `type: 'button'`, comme la réponse rapide d'un modèle, pas en `interactive`.
 */

export const ECHOS_MBA = {
  phraseAvantLeComposant: {
    "id": "wamid.ESSAI_01",
    "message": {
      "to": "33600000000",
      "text": {
        "body": "Voir les détails ci-dessous.\n",
        "preview_url": "true"
      },
      "type": "text",
      "recipient": "FR.ESSAI",
      "recipient_type": "individual",
      "biz_opaque_callback_data": "{\"originator\":\"bizai\",\"channel\":\"ent\"}"
    },
    "timestamp": "1791390000"
  },
  phraseAvantLeComposantEnAnglais: {
    "id": "wamid.ESSAI_02",
    "message": {
      "to": "33600000000",
      "text": {
        "body": "See the details below.\n",
        "preview_url": "true"
      },
      "type": "text",
      "recipient": "FR.ESSAI",
      "recipient_type": "individual",
      "biz_opaque_callback_data": "{\"originator\":\"bizai\",\"channel\":\"ent\"}"
    },
    "timestamp": "1791390000"
  },
  boutons: {
    "id": "wamid.ESSAI_03",
    "message": {
      "to": "33600000000",
      "type": "interactive",
      "recipient": "FR.ESSAI",
      "interactive": {
        "body": {
          "text": "Essai T0 : choisissez une option."
        },
        "type": "button",
        "action": {
          "buttons": [
            {
              "type": "reply",
              "reply": {
                "id": "biz_ai_qr_0",
                "title": "Option A"
              }
            },
            {
              "type": "reply",
              "reply": {
                "id": "biz_ai_qr_1",
                "title": "Option B"
              }
            }
          ]
        }
      },
      "recipient_type": "individual",
      "biz_opaque_callback_data": "{\"originator\":\"bizai\",\"channel\":\"ent\"}"
    },
    "timestamp": "1791390000"
  },
  liste: {
    "id": "wamid.ESSAI_04",
    "message": {
      "to": "33600000000",
      "type": "interactive",
      "recipient": "FR.ESSAI",
      "interactive": {
        "body": {
          "text": "Essai T0 : choisissez un créneau."
        },
        "type": "list",
        "action": {
          "button": "Voir les créneaux",
          "sections": [
            {
              "rows": [
                {
                  "id": "biz_ai_list_creneau_9h",
                  "title": "9 h"
                },
                {
                  "id": "biz_ai_list_creneau_10h",
                  "title": "10 h"
                },
                {
                  "id": "biz_ai_list_creneau_11h",
                  "title": "11 h",
                  "description": "le dernier"
                }
              ]
            }
          ]
        }
      },
      "recipient_type": "individual",
      "biz_opaque_callback_data": "{\"originator\":\"bizai\",\"channel\":\"ent\"}"
    },
    "timestamp": "1791390000"
  },
  formulaire: {
    "id": "wamid.ESSAI_05",
    "message": {
      "to": "33600000000",
      "type": "interactive",
      "recipient": "FR.ESSAI",
      "interactive": {
        "body": {
          "text": "Essai T0 : le formulaire de test."
        },
        "type": "galaxy_message",
        "action": {
          "name": "galaxy_message",
          "parameters": {
            "mode": "published",
            "flow_id": "3234400576763440",
            "flow_cta": "Remplir",
            "flow_token": "unused",
            "flow_action": "navigate",
            "flow_action_payload": {
              "screen": "FORM"
            },
            "flow_message_version": "3"
          }
        }
      },
      "recipient_type": "individual",
      "biz_opaque_callback_data": "{\"originator\":\"bizai\",\"channel\":\"ent\"}"
    },
    "timestamp": "1791390000"
  },
  lien: {
    "id": "wamid.ESSAI_06",
    "message": {
      "to": "33600000000",
      "type": "interactive",
      "recipient": "FR.ESSAI",
      "interactive": {
        "body": {
          "text": "Essai T0 : le lien de test."
        },
        "type": "cta_url",
        "action": {
          "name": "cta_url",
          "parameters": {
            "url": "https://app.messagingme.fr/",
            "display_text": "Ouvrir le site"
          }
        },
        "footer": {
          "text": "Message d essai"
        }
      },
      "recipient_type": "individual",
      "biz_opaque_callback_data": "{\"originator\":\"bizai\",\"channel\":\"ent\"}"
    },
    "timestamp": "1791390000"
  },
  image: {
    "id": "wamid.ESSAI_07",
    "message": {
      "to": "33600000000",
      "type": "image",
      "image": {
        "link": "https://app.messagingme.fr/img/partage/accueil.jpg",
        "caption": "Essai T0 : une image."
      },
      "recipient": "FR.ESSAI",
      "recipient_type": "individual",
      "biz_opaque_callback_data": "{\"originator\":\"bizai\",\"channel\":\"ent\"}"
    },
    "timestamp": "1791390000"
  },
  lieu: {
    "id": "wamid.ESSAI_08",
    "message": {
      "to": "33600000000",
      "type": "location",
      "location": {
        "name": "Tour Eiffel",
        "address": "Champ de Mars, 75007 Paris",
        "latitude": "48.8584",
        "longitude": "2.2945"
      },
      "recipient": "FR.ESSAI",
      "recipient_type": "individual",
      "biz_opaque_callback_data": "{\"originator\":\"bizai\",\"channel\":\"ent\"}"
    },
    "timestamp": "1791390000"
  },
  demandeDePosition: {
    "id": "wamid.ESSAI_09",
    "message": {
      "to": "33600000000",
      "type": "interactive",
      "recipient": "FR.ESSAI",
      "interactive": {
        "body": {
          "text": "Essai T0 : partagez votre position."
        },
        "type": "location_request_message",
        "action": {
          "name": "send_location"
        }
      },
      "recipient_type": "individual",
      "biz_opaque_callback_data": "{\"originator\":\"bizai\",\"channel\":\"ent\"}"
    },
    "timestamp": "1791390000"
  },
  carrouselLiens: {
    "id": "wamid.ESSAI_10",
    "message": {
      "to": "33600000000",
      "type": "interactive",
      "recipient": "FR.ESSAI",
      "interactive": {
        "body": {
          "text": "Essai T0 : deux cartes."
        },
        "type": "carousel",
        "action": {
          "cards": [
            {
              "body": {
                "text": "Carte accueil"
              },
              "type": "cta_url",
              "action": {
                "name": "cta_url",
                "parameters": {
                  "url": "https://app.messagingme.fr/",
                  "display_text": "Voir"
                }
              },
              "header": {
                "type": "image",
                "image": {
                  "link": "https://app.messagingme.fr/img/partage/accueil.jpg"
                }
              },
              "card_index": 0
            },
            {
              "body": {
                "text": "Carte chaînes"
              },
              "type": "cta_url",
              "action": {
                "name": "cta_url",
                "parameters": {
                  "url": "https://app.messagingme.fr/contact/",
                  "display_text": "Voir"
                }
              },
              "header": {
                "type": "image",
                "image": {
                  "link": "https://app.messagingme.fr/img/partage/chaines-whatsapp.jpg"
                }
              },
              "card_index": 1
            }
          ]
        }
      },
      "recipient_type": "individual",
      "biz_opaque_callback_data": "{\"originator\":\"bizai\",\"channel\":\"ent\"}"
    },
    "timestamp": "1791390000"
  },
  carrouselReponses: {
    "id": "wamid.ESSAI_11",
    "message": {
      "to": "33600000000",
      "type": "interactive",
      "recipient": "FR.ESSAI",
      "interactive": {
        "body": {
          "text": "Essai T0 : choisissez une carte."
        },
        "type": "carousel",
        "action": {
          "cards": [
            {
              "body": {
                "text": "Carte accueil"
              },
              "type": "button",
              "action": {
                "buttons": [
                  {
                    "type": "quick_reply",
                    "quick_reply": {
                      "id": "biz_ai_qr_carousel_Carte accueil",
                      "title": "Choisir accueil"
                    }
                  }
                ]
              },
              "header": {
                "type": "image",
                "image": {
                  "link": "https://app.messagingme.fr/img/partage/accueil.jpg"
                }
              },
              "card_index": 0
            },
            {
              "body": {
                "text": "Carte chaînes"
              },
              "type": "button",
              "action": {
                "buttons": [
                  {
                    "type": "quick_reply",
                    "quick_reply": {
                      "id": "biz_ai_qr_carousel_Carte chaînes",
                      "title": "Choisir chaînes"
                    }
                  }
                ]
              },
              "header": {
                "type": "image",
                "image": {
                  "link": "https://app.messagingme.fr/img/partage/chaines-whatsapp.jpg"
                }
              },
              "card_index": 1
            }
          ]
        }
      },
      "recipient_type": "individual",
      "biz_opaque_callback_data": "{\"originator\":\"bizai\",\"channel\":\"ent\"}"
    },
    "timestamp": "1791390000"
  },
} satisfies Record<string, Record<string, unknown>>;

export const CLICS_MBA = {
  clicBouton: {
    "id": "wamid.ESSAI_12",
    "from": "33600000000",
    "type": "interactive",
    "context": {
      "id": "wamid.ESSAI_13",
      "from": "33600000000"
    },
    "timestamp": "1791390000",
    "interactive": {
      "type": "button_reply",
      "button_reply": {
        "id": "biz_ai_qr_0",
        "title": "Option A"
      }
    },
    "from_user_id": "FR.ESSAI"
  },
  clicLigne: {
    "id": "wamid.ESSAI_14",
    "from": "33600000000",
    "type": "interactive",
    "context": {
      "id": "wamid.ESSAI_15",
      "from": "33600000000"
    },
    "timestamp": "1791390000",
    "interactive": {
      "type": "list_reply",
      "list_reply": {
        "id": "biz_ai_list_creneau_10h",
        "title": "10 h"
      }
    },
    "from_user_id": "FR.ESSAI"
  },
  reponseFormulaire: {
    "id": "wamid.ESSAI_16",
    "from": "33600000000",
    "type": "interactive",
    "context": {
      "id": "wamid.ESSAI_17",
      "from": "33600000000"
    },
    "timestamp": "1791390000",
    "interactive": {
      "type": "nfm_reply",
      "nfm_reply": {
        "body": "Sent",
        "name": "flow",
        "response_json": "{\"mail\": \"camille@example.com\", \"nom\": \"Martin\", \"prenom\": \"Camille\", \"_ref\": \"ref-essai\", \"flow_token\": \"unused\"}"
      }
    },
    "from_user_id": "FR.ESSAI"
  },
  clicCarte: {
    "id": "wamid.ESSAI_18",
    "from": "33600000000",
    "type": "button",
    "button": {
      "text": "Choisir chaînes",
      "payload": "biz_ai_qr_carousel_Carte chaînes"
    },
    "context": {
      "id": "wamid.ESSAI_19",
      "from": "33600000000"
    },
    "timestamp": "1791390000",
    "from_user_id": "FR.ESSAI"
  },
} satisfies Record<string, Record<string, unknown>>;
