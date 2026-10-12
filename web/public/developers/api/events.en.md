<!-- Markdown version of https://console.messagingme.app/developers/api/events, generated from the page (npm run doc:md). Français : https://console.messagingme.app/developers/api/events.md -->

# Events

<a id="signaux"></a>

## What the console sends back

When something happens on a contact, the console pushes an event, with the contact’s current state, to the tool your administrator connected in Settings > Integrations.

- Only the tools offered in Settings > Integrations receive them: this is not a webhook to an address of your choice.
- Names start with `em_`, and do not change from one tool to another, nor do the field names. A text is at most 300 characters long; a missing or empty value is not sent.
- The profile is designated by your own id, `externalId`: a contact without one is not sent back (the settings screen counts those signals). Pass it on every call: contact, send, message.
- The same event can arrive twice: deduplicate on `em_event_id`, which is stable.

> **Caution**
>
> A message’s text is never sent back. A conversation summary is sent only when the option is on in the settings: it contains the customer’s words.

## Timing

- Less than a minute in normal conditions. Every event carries the time it happened, not the time it arrives.
- Behind a campaign of several thousand recipients, delivery and read receipts can arrive tens of minutes late. Replies, clicks, unsubscribes and analysed conversations are not delayed.
- “At the end of a conversation”: after 25 minutes without a message, then the analysis pass, every 5 minutes. Expect about half an hour after the last message: enough for a follow-up, not for an immediate alert.
- After an outage of more than 24 hours, depending on the tool, a pending event may not go out. Only the record’s state read at sending time then goes out (its id, unsubscribes, last analysis); never what the event alone told (last reply, RCS reachability), which would overwrite a more recent state.

## The events

Values of `origine` : `humain`, `scenario`, `ia`, `mba`, `campagne`, `mcp`, `api`; of `canal` : `whatsapp`, `rcs`. A missing score (satisfaction, urgency) means “no measure”: it never overwrites the previous one.

| Event | When | Fields |
| --- | --- | --- |
| `em_message_delivered` | Within a minute; delayed behind a large campaign | `canal` `origine` `send_id` : send_id: the send (sendId) the message belongs to, only when it belongs to one |
| `em_message_read` | Within a minute; delayed behind a large campaign | `canal` `origine` `send_id` : Same fields as delivery |
| `em_message_failed` | Within a minute; delayed behind a large campaign | `canal` `origine` `send_id` `motif` `code_meta` : motif: the failure reason, when known. code_meta: Meta’s error code, for a WhatsApp message |
| `em_replied` | Within a minute, even during a large campaign | `canal` `bouton` : bouton: the label of the tapped button. Never the message text. A reaction (emoji) is not a reply. |
| `em_link_clicked` | Within a minute, even during a large campaign | `lien` `template` `destination` : lien: the tracked link code. Only when the click is attributed to a contact; an automatic click (preview, bot) does not count. destination: the address the link leads to, absent beyond 300 characters (a cut address would be wrong). |
| `em_opted_out` | Within a minute, even during a large campaign | `canal` `source` : canal: only when the person wrote STOP on that channel; absent for an unsubscribe set by your team or through the API. source: where the refusal comes from (whatsapp_stop, rcs_stop, crm, api…). |
| `em_conversation_analyzed` | At the end of a conversation | `intent` `sentiment` `satisfaction` `urgence` `resolved` `topic` `action_suggestion` `handled_by` `exchanges_count` `summary_1` `summary_2` `summary_3` : summary_1 to summary_3: the summary, only when the option is on, in chunks of at most 300 characters, to join end to end with no separator (the last ones are absent when it is short). |
| `em_risk_changed` | Every night, when the level changes | `niveau` `ancien_niveau` `score` `raisons` : niveau and ancien_niveau: inconnu, faible, moyen or eleve. raisons: up to three codes separated by commas (silence_60j, silence_30j, sans_reponse, non_lu, reclamation, negatif, insatisfait, injoignable, stop, bloque). |

## Contact attributes

| Contact attribute | Meaning |
| --- | --- |
| `em_contact_id` | The contact id (contactId), to designate the contact unambiguously in an API call |
| `em_last_intent` | The intent of the last analysed conversation (same values as the analysis screen) |
| `em_last_sentiment` | The sentiment of the last analysed conversation |
| `em_satisfaction` | Satisfaction, from 0 to 10. Missing from an analysis, it does not overwrite the previous one |
| `em_urgency` | Urgency, from 0 to 10, same rule |
| `em_last_resolved` | Is the last analysed conversation resolved? |
| `em_last_topic` | The topic of the last analysed conversation, in plain words |
| `em_last_handled_by` | Who handled it: humain, automatise or mba (the Meta agent) |
| `em_last_action_suggestion` | The action the analysis suggests: creer_devis, rappeler, relancer, escalader or aucune |
| `em_last_reply_at` | The date of the contact’s last reply |
| `em_whatsapp_optout` | Has the contact unsubscribed? |
| `em_rcs_optout` | Did they say STOP on the RCS channel? |
| `em_rcs_reachable` | Was the last RCS message delivered to them? |
| `em_risk_level` | The disengagement risk: inconnu, faible, moyen or eleve, recomputed every night |
| `em_risk_score` | The risk score, from 0 to 100 (absent when the level is inconnu) |
| `em_risk_reasons` | The main reasons for the level, up to three codes separated by commas |
