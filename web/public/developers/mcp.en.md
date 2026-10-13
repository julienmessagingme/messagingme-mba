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
| list_conversations | mcp:read | Conversations, most recently active first. |
| get_conversation | mcp:read | Thread details, and whether the 24 h window is open. |
| send_message | mcp:write | Send within the 24-hour window an image, a document, a location, buttons, a list or a link button, in Meta’s format. |
| list_templates | mcp:read | The workspace’s WhatsApp templates, with their language, category and status at Meta. |
| create_template | mcp:write OAuth connection required | Create a template in Meta’s format and submit it for review; a header image is given by its address. |
| send_template_to_contact | mcp:write OAuth connection required | Send an approved template to one person, even outside the 24-hour window, with the sends rules (consent, STOP, monthly templates). |
| get_template_status | mcp:read | A template’s status at Meta, language by language, with the reason for a rejection. |
| get_message_status | mcp:read | The delivery status of a sent message: sent, delivered, read or failed, with Meta’s reason. |
| get_messages | mcp:read | The last 50 messages of a thread, oldest first, and before to go further back. |
| search_contacts | mcp:read | Find a contact by name or number, with their latest analysis. |
| get_contact | mcp:read | A contact record from its number, with their latest analysis and its summary. |
| list_members | mcp:read | Workspace members, to assign threads to them. |
| reply_in_open_window | mcp:write | Reply, only while the 24 h window is open. |
| tag_conversation | mcp:write | Add tags to a thread’s contact. |
| assign_conversation | mcp:write | Assign a thread to a member, or release it. |
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
| set_default_responder | mcp:write OAuth connection required | Choose who answers the customer (a new contact, and every message nobody handles): Meta’s agent, an active AI agent, a published scenario, the team, or your app (an outgoing webhook address). Outside Meta’s agent mode, it stays on standby. |
| get_credit | mcp:read | The AI credit balance and its latest movements. |
| buy_credit | mcp:write OAuth connection required | Open a top-up payment, amount before tax; the person pays on the Stripe page themselves. |
| start_whatsapp_connection | mcp:write OAuth connection required | Give the link that opens the WhatsApp number connection, without the console, valid for one hour: provided or own number. |
| get_number_subscription | mcp:read | The provided number’s subscription: its status, the end of the paid period and the number. |
| resubscribe_number | mcp:write OAuth connection required | Renew the number subscription when it is overdue or ended: the Stripe portal, or a new payment that restores the same number. |
| return_number_at_plan_end | mcp:write OAuth connection required | Choose to give back the provided number when Pro ends, or keep it at €3.50 excl. VAT a month on the same card. |
| manage_number_subscription | mcp:write OAuth connection required | Open the Stripe portal for the number subscription: card, invoices, cancellation. |
| watch_whatsapp_connection | mcp:write OAuth connection required | Follow the number connection to the end: number assigned, verification code to read out, number connected. |
| create_webhook_endpoint | mcp:write OAuth connection required | Register the HTTPS address of the app that will receive the chosen events (signed outgoing webhook); the signing secret is shown only once. |
| list_webhook_endpoints | mcp:read OAuth connection required | The outgoing webhook endpoints, their event types and status, and the plan limit. |
| get_webhook_deliveries | mcp:read OAuth connection required | An endpoint’s log: each delivery, its status, the app’s answer and the body sent. |
| replay_webhook_delivery | mcp:write OAuth connection required | Replay a finished delivery: same body, same event id. |
| send_test_event | mcp:write OAuth connection required | Send a signed test event to an address right away, and read what the app answered. |

## What it does not do

- **No campaigns.** It sends a template to one person at a time, signed in as you; it does not launch a mass send.
- **Outside the 24 h window, only an approved template goes out.** A free-form message is refused, with the reason; an approved template goes out through send_template_to_contact.
- **WhatsApp number unlinked, nothing is sent.** The tool refuses, with the reason, until an admin relinks the number from the Home page.
- **Automations are not triggered.** A tag set by the assistant classifies the contact, without waking the automations listening for that tag.
- **Activating an AI agent does not make it answer.** Created and activated by the assistant, it talks to customers inside a published scenario that contains it, or once chosen to answer the customer (set_default_responder, “agent” mode): it then answers every message nobody handles, and Meta’s agent, if on, stays on standby.
- **Access goes through a key or an OAuth connection.** Either one carries the workspace and the scopes. To cut an assistant off: revoke its key or its authorization under "API keys".
