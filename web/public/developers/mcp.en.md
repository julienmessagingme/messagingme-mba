<!-- Markdown version of https://console.messagingme.app/developers/mcp, generated from the page (npm run doc:md). Français : https://console.messagingme.app/developers/mcp.md -->

# MCP server

Connect an assistant (Claude, or any MCP-compatible client) to the workspace, with no integration to build.

## Claude Code: the plugin

The simplest way in Claude Code: the Messaging Me plugin connects this server with no key, then /messagingme:demarrer sets the workspace up step by step (number, AI agent, bubble, test). The two commands, one after the other, then /mcp, plugin:messagingme:messagingme and Authenticate. With the plugin, do not also add the key-based command below: Claude Code would keep that server, which does not open the setup tools.

_Command 1_

```
/plugin marketplace add julienmessagingme/messagingme-plugin
```

_Command 2_

```
/plugin install messagingme@messagingme
```

_Then, in Claude Code_

```
/messagingme:demarrer
```

## Endpoint

_Endpoint_

```
https://api.messagingme.app/mcp
```

_Command to copy_

```
claude mcp add --transport http mba https://api.messagingme.app/mcp --header "Authorization: Bearer VOTRE_CLE"
```

Replace VOTRE_CLE with an API key holding an MCP scope. [Create a key](https://console.messagingme.app/developers/keys)

## Connect another client (ChatGPT, Cursor, VS Code, Lovable)

- Add a remote MCP server (or a connector) at https://api.messagingme.app/mcp, with no key, using OAuth authentication: the client opens our authorization page, where a workspace administrator signs in and picks the workspace.
- The page says where the client’s name comes from: verified for Claude, published by its domain for a client with an identity document (ChatGPT), unverified for a client that registers itself (Cursor, VS Code).
- The client receives its code on an https address, or on localhost and 127.0.0.1: a return through an app scheme (cursor://) is refused.

## What the assistant can do

A read-only key does not see the tools that write.

Tools marked "OAuth connection required" act on behalf of a person: an API key does not see them. They open when Claude connects to the workspace with an administrator’s consent, who signs what they do.

| Tool | Scope | What it does |
| --- | --- | --- |
| list_conversations | mcp:read | Conversations, most recently active first, over a period if needed, with each one’s contact. |
| get_conversation | mcp:read | Thread details, and whether the 24 h window is open. |
| send_message | mcp:write | Send within the 24-hour window an image, a document, a location, buttons, a list or a link button, in Meta’s format. |
| list_templates | mcp:read | The workspace’s WhatsApp templates, with their language, category and status at Meta. |
| create_template | mcp:write OAuth connection required | Create a template in Meta’s format and submit it for review; a header image is given by its address. |
| update_template | mcp:write OAuth connection required | Edit one language of a template, in Meta’s format, which goes back to review; a media header cannot be edited. |
| delete_template | mcp:write OAuth connection required | Delete a template, all its languages; refused while an active campaign uses it. |
| send_template_to_contact | mcp:write OAuth connection required | Send an approved template to one person, even outside the 24-hour window, with the sends rules (STOP, monthly templates); the person’s agreement is declared by the client. |
| get_template_status | mcp:read | A template’s status at Meta, language by language, with the reason for a rejection. |
| get_message_status | mcp:read | The delivery status of a sent message: sent, delivered, read or failed, with Meta’s reason. |
| get_message_stats | mcp:read | Message figures as chart-ready series: templates sent, delivered, read, failed; with the plan’s statistics, categories, exchanges, contacts and estimated cost. |
| get_campaign_stats | mcp:read | The period’s campaigns with their estimated cost, clicks and Meta errors, or one campaign’s funnel. |
| get_conversation_insights | mcp:read | What the analysis understood of conversations: sentiment, intents, resolution, topics, and satisfaction and urgency over time. |
| get_ai_stats | mcp:read | AI agent figures: cost of agent turns on the credit, messages written by AI, requests opened for the team and actions triggered. |
| get_revenue_stats | mcp:read | What your WhatsApp sends brought in on the Shopify store: gross revenue per currency, its proven part, the breakdown by source, and the checkouts reminded and recovered; test orders apart. |
| get_messages | mcp:read | The last 50 messages of a thread, oldest first, and before to go further back. |
| find_contacts | mcp:read | The contacts of a target, like the contact list filters: tags, consent and, on the Enterprise plan, the latest analysis. The total, and up to 100 contacts. |
| tag_contacts | mcp:write OAuth connection required | Tag the contacts of a target or of a list of conversations: a segment is a tag. Through the console’s bulk action, without starting any automation. |
| prepare_campaign | mcp:write OAuth connection required | Prepare a template campaign without sending anything: a draft visible in the console, a summary (targeted, sent, left out and why, five names, the billable volume) and a confirmation code. |
| launch_campaign | mcp:write OAuth connection required | Launch, or schedule for its date, a prepared campaign, with the code of its summary, once the person said yes; through the same path as the console’s Launch button. Also resumes a paused campaign, with the code of control_campaign. |
| control_campaign | mcp:write OAuth connection required | Pause a sending campaign, unschedule a scheduled one, or prepare to resume a paused one (a summary and a code). |
| list_fields | mcp:read | The custom contact fields: key, label, type. A template variable can come from one of them. |
| create_field | mcp:write OAuth connection required | Create a custom field, as in the console: its key comes from the label. |
| set_contact_field | mcp:write OAuth connection required | Set a field on the contacts of a target or of a list of conversations, like the console’s bulk action, without starting any automation. |
| connect_shopify | mcp:write OAuth connection required | Connect the merchant’s Shopify store with the app the shopify skill created in its organization; the connection is checked with Shopify before the secret is kept, encrypted. |
| set_shopify_message | mcp:write OAuth connection required | Send a message when an order is paid or fulfilled, or remind an abandoned checkout once: an approved template, with Shopify data, through the sends rules (STOP, monthly templates, contact limit); the customer’s record becomes opted in, under the merchant’s responsibility. A number linked by QR code cannot send them: it never writes first. |
| get_shopify_state | mcp:read OAuth connection required | The connected Shopify store: its state, its messages, the last event received, the last 30 days of outcomes and the last 7 days of checkouts. |
| preview_shopify_customers | mcp:read OAuth connection required | Count, writing nothing, the Shopify customers subscribed to marketing (email or SMS) who have a phone: already in the workspace, new, free places of the plan, importable. |
| import_shopify_customers | mcp:write OAuth connection required | Import the subscribed Shopify customers the merchant chose, newest first: records tagged Shopify, opted in by the client’s declaration, within the plan’s limit. |
| disconnect_shopify | mcp:write OAuth connection required | Cut the Shopify store: no message leaves anymore, the store’s privacy requests are still honored. |
| search_contacts | mcp:read | Find a contact by name or number, with their latest analysis. |
| get_contact | mcp:read | A contact record from its number, with their latest analysis and its summary. |
| block_contact | mcp:write OAuth connection required | Block or unblock a contact: nothing is sent to them anymore, their messages are still recorded. |
| prepare_contacts_deletion | mcp:write OAuth connection required | Prepare the deletion of a selection of contacts without erasing anything (tags, consent, a list, the N oldest, 1,000 at most): their count, 10 records at most and a confirmation code. |
| delete_contacts | mcp:write OAuth connection required | Delete for good the contacts of a prepared selection, with the same selection and its code: records, conversations and messages erased, as in the console; refused if the selection no longer designates the same contacts. |
| list_members | mcp:read | Workspace members, to assign threads to them. |
| reply_in_open_window | mcp:write | Reply, only while the 24 h window is open; on a number linked by QR code, outside the window, a reply to a customer who wrote is queued; this number never writes first. |
| tag_conversation | mcp:write | Add tags to a thread’s contact. |
| assign_conversation | mcp:write | Assign a thread to a member, or release it. |
| control_conversation | mcp:write | Take over a thread, or hand it back to the automatic responder, which answers the next message. |
| get_plan | mcp:read | The workspace plan, its limits and current usage, with the link to upgrade. |
| get_setup_state | mcp:read | Where the workspace setup stands (number, AI agent, responder, bubble, credit, plan), and the next step with its tools. Call it first to set up a workspace, or to resume. |
| list_widgets | mcp:read | The workspace’s WhatsApp widgets, with the tag to paste on the site. |
| list_scenarios | mcp:read | Scenarios, and which are published: a widget only starts a published scenario. |
| create_widget | mcp:write | Create a WhatsApp widget, with the screen’s checks, and get its tag. |
| update_widget | mcp:write | Edit a widget; its tag never changes. |
| list_agents | mcp:read | AI agents, their status, and what is still missing before they can be activated. |
| get_agent | mcp:read | An AI agent: its profile, model, tools, knowledge, what it lacks, and the offered models with their price. |
| create_agent | mcp:write OAuth connection required | Create a draft AI agent. A workspace’s first agent needs a little credit. |
| update_agent | mcp:write OAuth connection required | Edit an AI agent’s profile (goal, tone, handovers, stop rules) and its model, logged under the person’s name. |
| set_agent_limits | mcp:write OAuth connection required | Set the limits of an AI agent’s conversation (answers, actions, credit spent, no credit limit by default), logged under the person’s name. |
| set_agent_tools | mcp:write OAuth connection required | Add and enable an AI agent’s four safe tools (finish, search, read the contact, hand over). |
| activate_agent | mcp:write OAuth connection required | Activate a complete AI agent, or deactivate it. It answers in a published scenario, or if chosen to answer the customer. |
| test_agent | mcp:write OAuth connection required | Try an AI agent on a mock conversation. Each try is charged to the credit. |
| list_knowledge | mcp:read | An AI agent’s knowledge entries, with their source. |
| add_knowledge | mcp:write OAuth connection required | Add written knowledge entries, up to 50 per call. |
| delete_knowledge | mcp:write OAuth connection required | Delete knowledge entries; their content stays in the history. |
| preview_site | mcp:read OAuth connection required | Read a site from the server and see what an import would make of it, without writing anything. |
| import_site | mcp:write OAuth connection required | Import a site’s pages as knowledge; a page read again replaces its entries. |
| import_document_text | mcp:write OAuth connection required | Import a document’s text under its name, filed like an uploaded document. |
| set_transfer_mode | mcp:write OAuth connection required | Set what AI agents promise about team availability when they hand over. |
| set_business_hours | mcp:write OAuth connection required | Set the workspace’s opening hours and time zone: the ones AI agents announce outside hours. |
| set_agent_action | mcp:write OAuth connection required | Create or edit an AI agent action: what it collects and sends to your app (agent.action webhook) when the customer makes a request, once a day per contact. |
| delete_agent_action | mcp:write OAuth connection required | Delete an AI agent action. |
| set_default_responder | mcp:write OAuth connection required | Choose who answers the customer (a new contact, and every message nobody handles): Meta’s agent, an active AI agent, a published scenario, the team, or your app (an outgoing webhook address). Outside Meta’s agent mode, it stays on standby. |
| get_credit | mcp:read | The AI credit balance and its latest movements. |
| buy_credit | mcp:write OAuth connection required | Open a top-up payment, amount before tax; the person pays on the Stripe page themselves. |
| subscribe_pro | mcp:write OAuth connection required | Open the Pro plan payment, monthly or yearly, amount before tax; the person pays on Stripe’s page and comes back to “Payment received”. |
| create_api_key | mcp:write OAuth connection required | Create your application’s API key, shown only once: it passes through the conversation, to put at once in the .env file. |
| start_whatsapp_connection | mcp:write OAuth connection required | Give the link that opens the WhatsApp number connection, without the console, valid for one hour: provided or own number, or the WhatsApp Business app number, keeping the app (messages sent through Messaging Me are billed by Meta). Without a Meta Business account, Meta’s window creates it along the way. |
| get_number_subscription | mcp:read | The provided number’s subscription: its status, the end of the paid period and the number. |
| resubscribe_number | mcp:write OAuth connection required | Renew the number subscription when it is overdue or ended: the Stripe portal, or a new payment that restores the same number. |
| return_number_at_plan_end | mcp:write OAuth connection required | Choose to give back the provided number when Pro ends, or keep it at €3.50 excl. VAT a month on the same card. |
| manage_number_subscription | mcp:write OAuth connection required | Open the Stripe portal for the number subscription: card, invoices, cancellation. |
| watch_whatsapp_connection | mcp:write OAuth connection required | Follow the number connection to the end: number assigned, verification code to read out, number connected, or linked while keeping the WhatsApp Business app. |
| create_webhook_endpoint | mcp:write OAuth connection required | Register the HTTPS address of the app that will receive the chosen events (signed outgoing webhook); the signing secret is shown only once. |
| list_webhook_endpoints | mcp:read OAuth connection required | The outgoing webhook endpoints, their event types and status, and the plan limit. |
| get_webhook_deliveries | mcp:read OAuth connection required | An endpoint’s log: each delivery, its status, the app’s answer and the body sent. |
| replay_webhook_delivery | mcp:write OAuth connection required | Replay a finished delivery: same body, same event id. |
| update_webhook_endpoint | mcp:write OAuth connection required | Edit an endpoint: its event types, a pause, or a new secret, shown once. |
| delete_webhook_endpoint | mcp:write OAuth connection required | Delete an endpoint and its log; to change its URL, delete it and create it again. |
| send_test_event | mcp:write OAuth connection required | Send a signed test event to an address right away, and read what the app answered. |

## What it does not do

- **No campaign without your yes.** On Pro, it prepares a campaign and shows you its summary; it only launches it with the code of that summary, after your yes. Outside Pro, it sends a template to one person at a time.
- **Outside the 24 h window, only an approved template goes out.** A free-form message is refused, with the reason; an approved template goes out through send_template_to_contact.
- **WhatsApp number unlinked, nothing is sent.** The tool refuses, with the reason, until an admin relinks the number from the Home page.
- **Automations are not triggered.** A tag set by the assistant classifies the contact, without waking the automations listening for that tag.
- **Activating an AI agent does not make it answer.** Created and activated by the assistant, it talks to customers inside a published scenario that contains it, or once chosen to answer the customer (set_default_responder, “agent” mode): it then answers every message nobody handles, and Meta’s agent, if on, stays on standby.
- **Access goes through a key or an OAuth connection.** Either one carries the workspace and the scopes. To cut an assistant off: revoke its key or its authorization under "API keys".
