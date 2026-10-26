---
slug: build-an-ai-agent
traduit_de: 8f66a8
description: Build an AI agent that answers on WhatsApp: the interview, the knowledge base, the tools, the stop rules, the test and the credit.
---
# Build an AI agent

An AI agent is a responder you build yourself and that you **place where you need it**: in the “AI agent” block of
a scenario, or **to answer the customer**, on any message that nobody is handling, as Meta’s agent does. Outside
these two places, it does not speak.

**The AI agent that answers the customer.** It is chosen on the Home screen, in **“Who answers the customer”**
(the “An AI agent” position, among your active agents), then **Save**; the agents page links there. The chosen
agent answers any message that neither a scenario, nor a keyword, nor a member of your team is handling, with no
scenario to build, and taking into account what the contact has just written. Meta’s agent is not turned off for
all that: turned on, it stays on standby, and only takes the contacts a “Send to the MBA” block sends to it. If it
was the one answering, the Home screen asks you to confirm, because it stops answering the conversations it holds.

With no scenario behind it, a stop rule or “No reply” ends the agent’s conversation; “Handover to a human”, “No
source”, “Cap reached” and “Technical failure” pass it to your team, in “To handle”. The Inbox Detail panel notes
each exit (“The AI agent has finished”, with the rule), and the contact’s next message starts the agent again
(after a handover, once your team has handed back control). A thumbs up, or another reaction to a message, does
not make it answer. **With no credit left, every message goes to your team**, with no automatic reply, and the
admins get an email alert, one a day at most. Turning off or deleting the agent that answers removes it from this
role: messages then go to your team, the screen tells you before, and the Home screen flags it. It only answers
WhatsApp messages.

**An agent is born as a draft** and only appears in the scenario builder, or in “Who answers the customer”, once
**activated**, when you have reread what it will say. Here, “activated” means “can be chosen”, not “it answers
everything”: answering everything is chosen on the Home screen. Activation refuses an incomplete agent, but it
tells you what to do: each gap is a clickable line that opens the tab where it is fixed, and the record’s header
lists them as soon as you open it, without waiting for you to click “activate”.

**The record’s header identifies it at a glance**: the logo of its model’s provider, its name and its model, its
Draft / Active / Disabled badge, and the number of messages exchanged over the last 30 days in the conversations it
held, once that number is known. It counts the whole thread, incoming and outgoing, including campaign sends and
what your team wrote after taking back control from the agent: it is therefore not a measure of what the agent
itself produced, and it is not the same scope as the “messages exchanged” of the Home screen and the Performance
Lab either, which leave out templates sent. Your tests from the Test tab are not included, and as long as this
number is not known, nothing shows. The record’s menu sits as a column to the left of the content; on a phone, it
becomes the bar at the top again.

**You can also have Claude build it.** Once Claude is connected to your workspace (Developers > MCP server), it
creates the agent, reads your site, tests it and activates it, with the same checks as this screen. Its changes
appear in the agent’s History tab, “by Claude”.

**Start by talking to it.** The first tab is not an empty form but a conversation: describe your business, and the
assistant goes over the subject point by point, one question at a time (what the agent is there to do, what it
never talks about, where its substantive answers come from, the moments when it must do something other than
answer, when it lets go of a silent contact, when a human takes over, under which name it introduces itself,
whether it says it is an AI, how it speaks). If you mention several moments at once, it takes them one by one.
When you give it your site’s address, it imports the pages by itself: they wait for you in the Knowledge base tab.
As long as a point has not been settled, it shows you nothing and tells you how many are left. It changes
**nothing** by itself: it proposes, and the screen shows line by line what that would change, with the previous
value struck through. Each rule can be kept, corrected in place or discarded separately. You can attach a
document or a photo (a price list, for example): its text is extracted and split into knowledge cards.

**A moment when the agent must start a scenario is set in the interview.** The next question lists your live
scenarios by name: name the right one. The proposal then carries a “Tool “Start a scenario”” line, with the
situation in which to call it, to correct if needed, and “Save” places the tool in the Tools tab, “Inactive”. You
still have to tick “Allow the agent to do this alone” (“Edit” on its line) and click “Activate”. If the name you
give does not point to a single live scenario, nothing is placed, and the “To finish” list tells you how to add it
by hand.

**At the end of the interview, follow the “To finish” list.** It says, in order, what is left to do for your
agent: save the proposal (“Save” button), import your site into Knowledge base, plug in the connector a moment
requires, activate the tool of the placed scenario, check its model in the Model tab, test it, then activate it.
A step already done does not appear in it.

**Its knowledge base is the only thing it is allowed to use.** On a question no card covers, it does not make
things up: it leaves the block through “No source”. An empty base therefore makes an agent that hands everything
over. You fill this base in four ways: by pasting the address of a page of your site, which is read once and split
into cards; by uploading a document (PDF, Word, text or CSV); by writing a card by hand; or by attaching a document
to the assistant. Your domain’s address makes it read your site, up to fifty pages close to the home page, and a
preview shows you what would be imported before anything is written. A slow site is read for 30 seconds at most:
the preview then says pages are missing, and an import stopped for lack of time offers you, in one click, the
pages it could not read. A CSV, a price list for example, is split by whole rows, its header repeated in each card,
and the one Excel saves on Windows goes through too. A card is at most 2,000 characters, what the agent reads of
it: a longer section becomes several cards “(continued 2)”, “(continued 3)”, nothing is cut. Beyond 40 cards, the
rest of a page or a document is not read, and the screen says so, page by page. The source is written under each
card, and a card nobody has touched for more than ninety days carries a “To reread” badge.

**Tools are what it is allowed to DO**, on top of talking. The Tools tab has the shape of Meta’s agent’s. At the
top, **“Always there”**: the AI agent’s own moves (end with a stop rule, hand over to a human, search its knowledge
base, read the contact record, mark the conversation urgent), with the same controls as your tools: “Activate”
places the tool then activates it, “Deactivate” deactivates it, “Edit” opens its instructions, and the cross
deletes it. Then **“Add a tool”** opens the “Which tool to add?” grid: set a tag, save a piece of information, send
a block, start a scenario, call an API connector, call an MCP tool, and two tools specific to the AI agent: trigger
an action, and chain steps. Finally, the list of placed tools, each with its status (“Active” or “Inactive”),
“Activate” or “Deactivate”, “Edit” and the cross that deletes. Seven things to remember:

- **The tag, the information, the block and the scenario are chosen by you**, one per tool: the agent only decides
  the moment, and for a piece of information, the value (limited to the list you give, if you give one). “Start a
  scenario” makes **the scenario take over the conversation**: the agent steps back and writes nothing more; an
  unpublished or deleted scenario is refused, and the agent carries on. “Send a block” sends the block alone,
  without what follows it, and the agent keeps control.
- **A tool can only be used once activated**, by you or by Claude on your behalf. As long as it is not, the agent
  does not even know it exists. The most costly case is a well-filled base with the search tool left inactive:
  the agent then hands over every substantive question, and yet the screen looks in order. A tool placed from the
  grid is born “Inactive” too, and is activated from its line. An agent never carries two tools with the same
  name: the second is refused, because the model would refuse the whole list and the agent would stop answering.
- **What goes out to the customer needs your consent**: on “Send a block” and “Start a scenario”, tick “allow the
  agent to do this alone”, otherwise every call is refused, and the tool’s line says so.
- **Words matter a lot.** “When to call it” and “when NOT to call it” are two separate fields, and they are what
  the model reads to decide.
- **An action makes your application act.** “Trigger an action”: you name it (“Cancellation”), you write its
  instruction (when to trigger it, and what the agent then tells the customer) and the information it collects, up
  to ten, all optional (text, number, date, email or list of values). When the customer makes the request, the
  agent answers what the instruction says and carries on, and your application receives the “AI agent action”
  event, once a day at most per contact and per action. This event is unticked by default: tick it on an address
  in Developers > Outgoing webhooks, otherwise nothing goes out, and the action’s card reminds you. A field’s code
  is the key your application reads: do not change it once the application is plugged in. An automation can also
  start from the action (Automation menu).
- **Several actions at once, in your order.** “Chain steps”: a first step, then “+ Add a step”, and the arrows to
  reorder. For example: ask for the first name, the last name, the campus and the programme, then start the
  scenario that passes the contact to your team. If an answer is missing, the agent asks for it **only once**,
  then runs everything with what it has, even if the contact refuses. Two rules, which the screen reminds you of: a
  scenario or a handover to “To handle” goes last (only one of the two), and no block or scenario comes before a
  question (questions always go first). As soon as a block or a scenario is part of it, tick “allow the agent to do
  this alone”. “Save a piece of information” stores a single answer, in a field the agent reads in plain text and
  that the proposed title quotes.
- **Qualify before handing over, or hand over right away: you have to choose.** “Qualify and hand over” has neither
  a title nor a name to choose, and “When to call it” is already filled in. It asks your questions (each one in a
  field chosen from the list, “+ Add a question”), only once, then moves the conversation to “To handle”, even if
  the contact answered nothing. As with “Hand over to a human”, the agent only says its last sentence if it answers
  the number alone or if the team is closed; otherwise, what follows the “Handover to a human” exit of your scenario
  does the talking. It cannot coexist with “Hand over to a human” nor with a stop rule ticked “hands over to a
  human”: activating one while the other is there is refused, and the message says what to deactivate first.

**Stop rules draw the block’s exits.** A stop rule is “when the agent has finished doing this, it leaves through
there”: you give it a code and a label, and each one becomes an exit to connect in the builder, twelve at most.
Five exits are always there on top of yours: **No reply** (the contact went quiet), **No source**, **Handover to a
human**, **Cap reached** and **Technical failure**. An exit that leads nowhere is flagged in red.

**Try it before activating it.** The Test tab lets you talk to the real agent, with its goal, its tone, its tools
and its real base: what it answers there is what it will answer. Each tool call is shown with what it asked for and
what it received, because “it did not find” and “it did not even search” are not the same flaw. Actions that touch
the real world are simulated there, except an API connector call that only reads your system (a GET request given
to the agent as “it fetches information”, with no contact data): that one goes out for real, so that you see a
real quote. Your tests are kept fourteen days, and “Replay” asks the agent, as it is set up now, exactly the same
question: that is how you see whether an instruction made any difference.

**What it reads.** At each turn, an agent rereads the last 30 messages exchanged with the contact, over 30 days,
whatever the conversation, and its first turn reads the message that triggered it.

**The credit.** Each workspace has a prepaid balance, shown at the top of the agents list and stated in euros. The
balance goes down at each turn, at the rate shown in the list of models, knowledge base search included, and also
when knowledge cards are prepared and at each translation or transcription in the Inbox. A warning appears when it
gets low, and a red banner at zero. An administrator tops it up in the **AI credit** tab of **Settings > Plan** (5,
10, 50 or 100 € excluding tax, paid on Stripe’s page), and 1 € is offered for the workspace’s first WhatsApp number,
once Meta has verified it. **With no credit, you cannot create an agent and the sandbox refuses**: a test really
calls the model, it is paid like a conversation.

**Three caps** protect each conversation on top of the balance: the number of the agent’s replies (20 by default),
the number of its actions, a search in its base or a tool (60 by default), and the credit spent (no limit by
default: your balance is what caps the spend). The first one reached makes the journey leave through “Cap
reached”, which is an exit to plug in. They are set in the agent’s **Scope** tab (the credit with a “No limit” box
and an amount in euros), or by asking Claude.

**The AI disclosure**, finally, is required and can never be empty. The sentence belongs to the agent, the moment
it is said belongs to your workspace and is set in Security > AI: never, once per session, or at every message. The
platform places it at the top of the agent’s message, not the model: it goes out even when the agent checks its
base before answering, and the Test tab shows it to you as the contact will read it. Meta’s agent is not concerned,
it already adds its own.
