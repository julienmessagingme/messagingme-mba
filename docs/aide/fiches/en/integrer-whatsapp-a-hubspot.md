---
slug: integrate-whatsapp-with-hubspot
traduit_de: 9a0a05
description: WhatsApp in HubSpot with the Messaging Me app: reply from the contact record, send from your workflows, analyze every conversation. Without Sales Hub.
---
# Integrate WhatsApp with HubSpot, without Sales Hub

The Messaging Me app puts WhatsApp in HubSpot: your teams reply to customers from the contact record, your workflows
send templates and launch scenarios, and every conversation comes back analyzed. Without Sales Hub, and without Data
Hub for webhooks.

## What the app does

- **Reply from the contact record.** The Messaging Me card shows the WhatsApp conversation, and anyone in the portal
  replies there, each reply signed with their address. When the customer has not written for 24 hours, it offers your
  approved templates, already filled in from the record.
- **A “Messaging Me” page in HubSpot.** It lists the conversations waiting for a person, urgent ones first: you reply
  there without looking for the contact record.
- **A task as soon as a customer asks for a human.** It reaches the contact owner within a minute, with the link to the
  conversation, and checks itself off when someone replies.
- **Your HubSpot workflows write on WhatsApp.** Three actions join your workflows: send a template, launch a scenario,
  or launch it from a deal, with the advisor and their booking link.
- **A deal stage launches a scenario.** When a deal reaches the chosen stage, its contact receives the scenario,
  without writing a workflow.
- **The analysis of every conversation.** The intent, the sentiment and the suggested action land on the record, as
  properties your workflows can follow, with a task and one-click actions: create or attach the quote, call back,
  escalate to a human.
- **Your HubSpot lists as audiences.** A WhatsApp campaign targets a HubSpot list.

## What you need in HubSpot

**No need for Sales Hub.** The card, the page, the tasks, the analysis and the lists work whatever your HubSpot plan.
**No need for Data Hub either** (formerly Operations Hub), the only HubSpot plan that gives workflows the webhook
action: the scenario a deal stage triggers listens to HubSpot through the app itself. Only the three workflow actions
need HubSpot workflows, which a Pro subscription brings: Marketing Hub Pro is enough.

## Set it up

Everything is set in the console, on the HubSpot card of Tools > Integrations, reserved for administrators. Each
feature turns on and off with a switch.

**1. Connect HubSpot.** In Tools > Integrations, the HubSpot card offers “Connect HubSpot”, with or without a WhatsApp
number: you authorize the Messaging Me app on your portal, at HubSpot, in another tab.

A brand new workspace can therefore connect HubSpot before it has a number.

**2. Choose what you connect.** When you come back, the card asks what goes into HubSpot: the contact record and the
analysis of every conversation, the immediate task when a customer asks for a human, the creation of tasks, the
contact unreachable on WhatsApp, your lists as a campaign audience.

Without “Create tasks in HubSpot”, only the properties arrive, for your HubSpot workflows; this setting applies to the
whole portal. If the right to read your lists is missing, “Authorize access to HubSpot lists” asks the portal for it.

**3. Add the card to the contact record.** In HubSpot, open Settings, then Objects, Contacts and the “Record
customization” tab. Open the default view and, in the middle column, “Add cards”: search for “Messaging Me”, add the
card, save.

**4. Reply from HubSpot.** Turn on “Reply to customers from HubSpot”, off at first. Anyone in the portal then reads the
conversation in the card and replies, signed with their address, as long as the 24-hour window is open; “Hand back to
the bot” gives control back to the agent.

The card never writes to a contact who said STOP or to a blocked contact. A conversation held by a member can only be
answered by them, an admin or a manager, and each person sends at most 20 replies a minute.

The “Messaging Me” page in HubSpot (the Marketplace icon, then the app) lists the conversations waiting for a person:
urgent ones first, then the longest wait. “Open” shows the conversation so you can reply, as from the card. Anyone in
the portal sees the whole list, whatever their rights on contacts in HubSpot. If the number's sync is paused, the page
says so.

**5. Send templates from HubSpot.** Turn on “Send templates from HubSpot”, offered once replying is on. When the
customer has not written for 24 hours, the card offers your approved templates, with their variables already filled in
from the contact record: you check them, then “Send the template”.

A Marketing template only goes to a contact who has agreed; the other templates go to any contact who has not said
STOP and is not blocked. Meta charges for each template, and each person sends at most 5 a minute.

**6. Connect your HubSpot workflows.** Turn on “HubSpot workflows: send templates and launch scenarios”. Your contact
workflows gain “Send a WhatsApp template (Messaging Me)” and “Launch a Messaging Me scenario”, your deal workflows
“Launch a Messaging Me scenario (deal)”.

With the line off, the actions stay visible in HubSpot but do nothing: the workflow history says workflows are not
enabled. In the action, you choose the workspace, an approved Utility template or a published scenario that starts with
such a template and contains no Marketing template, the property holding the contact's WhatsApp number and, for each
template variable, the property that fills it (fixed text lives in the template). A scenario that starts with a
question, a quick message or the AI agent is not offered: WhatsApp requires the contact to have written within the
last 24 hours.

Nothing goes to a contact who said STOP or is blocked, nor to a landline, nor the same template or scenario to the same
contact twice within 24 hours; Marketing templates are not offered. A scenario never goes to a conversation an agent
has taken over, and it replaces an automatic scenario in progress. The workflow history says, contact by contact, what
was sent or why nothing was sent, and each send shows up in Campaigns. At most 60 sends a minute and 2,000 a day for
the workspace, all three actions counted together; Meta charges for each template.

The deal action writes only to the one contact associated with the deal: with several associated contacts, nothing is
sent. It sets three fields on their Messaging Me record, declared when you turn the line on: **Prénom (HubSpot)**
(first name), **Conseiller (HubSpot)** (the deal owner, their advisor) and **Lien d'agenda (HubSpot)** (the advisor's
booking page, when Messaging Me can read it). The variables of its opening template come from the sources set on the
template (for instance “{{1}}” = Prénom (HubSpot)), and the scenario's messages can write “{{hubspot_conseiller}}” or
“{{hubspot_lien_agenda}}”. In the opening template, only set what is always filled in, such as the first name: an
empty variable stops the send. The advisor and their link go in the messages that follow, and these three fields only
serve the scenarios launched by this action.

Place the action right after the trigger, and turn re-enrollment on so that a revised proposal goes out again (it is
refused within 24 hours). Do not also connect a console automation to the same stage: the contact would receive two
scenarios.

**7. Launch a scenario at a deal stage.** No workflow needed: in Automation, the “a HubSpot deal reaches a stage”
trigger launches the scenario of your choice to the deal's contact, when the deal reaches that stage. You pick the
stage by its name; renaming it later in HubSpot breaks nothing.

Since the contact is not writing at that moment, the scenario starts with a template. A deal without a contact, or a
contact without a number, triggers nothing, and a deal moved several times in a row only triggers once.

**8. Follow, pause or cut off.** On the Home screen, the HubSpot block shows the portal, the sync status and whether
your lists serve as audiences. Cutting off the sync makes you choose between a pause, which can be undone, and a full
disconnection.

The analyses produced during a pause are sent when it resumes. The full disconnection unlinks the HubSpot account and
cuts off every number of the workspace; with no number, it is a button of the block, without the pause option. With no
portal linked, the Home screen only shows a line that sends you to Integrations.
