---
slug: send-an-rcs-message
traduit_de: 7f9f0b
description: Send an RCS message: turn on the channel, compose a message or a carousel and its buttons, then send it in a campaign, a scenario or from the Inbox.
---
# Send an RCS message

RCS is the second channel, next to WhatsApp. Your messages go out under a **brand agent**: your name and your logo
show in the recipient’s Messages app, with the verification badge.

There is no sender number, and above all **no
template to get approved**: you write, you save, you send.

**The channel stays off until an API key is set.** On the Home screen, under your WhatsApp number, the “Turn on RCS”
button asks for this key, checks it with the provider and shows what it gives access to (agent name, traffic type,
quotas). While the channel is off, the RCS blocks stay visible but greyed out: nothing can go out.

**The library** (Content > RCS messages) is where you compose reusable messages. A text, an optional header image,
variables replaced by the contact record when sending, emojis, and up to eleven buttons. The preview lives in a
phone frame in your brand, and the form tells you what is missing instead of greying out its button with no
explanation. With an image, the text is limited to 2,000 characters instead of 3,072.

**A carousel** is the other format: from 2 to 10 cards that scroll horizontally, each with its visual, its optional
title, its text and up to four buttons **of its own**. What is missing is named card by card. Changing format means
creating another message; switching between the two in the form, however, loses nothing you have entered.

**Six kinds of button**, the same everywhere: **Reply** (the contact replies in one tap), **Link**, **Call**,
**Calendar** (adds the appointment to the phone’s calendar), **See a place** and **Ask for location**. Only a Reply
button opens an exit to connect in a scenario: the five others act on the phone or leave the conversation, they
send back nothing that would let you choose a branch. For a Calendar button, the date is set by hand or taken from
a “date and time” field of the record; a contact with no date loses the button and still receives the message.

**The buttons’ look is chosen by adding a visual**, not in a setting: with an image, they show as a full-width list
in the card and stay there (four at most); without an image, as small chips under the bubble, which disappear as
the conversation moves on (eleven at most). The recipient’s Messages app decides, and the preview shows you both
forms.

**The visual is uploaded from the console**: you choose an image on your computer (JPEG, PNG or GIF, 2 MB maximum)
and the address fills in by itself. The field also accepts a pasted address if you already host your visuals
elsewhere.

**In a campaign**, choose “An RCS message” as content, then start from a saved message or write directly. Contacts
with no mobile number are counted as “skipped” with their reason: RCS is for a mobile, a landline cannot receive
it. A carousel chosen in a campaign is **copied in full** onto the stage: to change it, change it in the library
then choose it again.

**In a scenario**, the “RCS message” block has two delivery exits, **Sent** and **Unreachable**, plus one exit per
reply button. Connecting “Unreachable” to a WhatsApp template send gives the cascade: RCS first, WhatsApp for those
it does not reach. The provider cannot tell in advance whether a number is reachable over RCS: this exit therefore
fires on the delivery report, a few moments to a few minutes after sending, and not when the block is reached.

**The channel follows the conversation, not the block.** A scenario that starts over RCS continues over RCS. To
switch to WhatsApp on purpose, plug in a template send: the journey moves there and stays there. A scenario can
therefore **start** with an RCS message even when the WhatsApp 24-hour window is closed, since RCS has no window.
One exception the editor flags: a WhatsApp **form** placed right after will only go out if the contact wrote on
WhatsApp within 24 hours, because replying over RCS does not reopen that window.

**From the Inbox**, the 📱 button sends an RCS message from your library to the open contact, or, in the “Free
reply” tab, your own sentence, which goes out as is under the brand agent. It is offered even when the WhatsApp
window is closed: it is often the simplest way to get back in touch.

**Two points on replies and figures.** A contact who replies STOP is unsubscribed from RCS without it affecting their
WhatsApp consent. And the two channels do not mix in your measures: a reply received over RCS does not count as a
reply to a campaign’s WhatsApp template. RCS has a price, yours, and it goes into the cost per engagement like the
rest.
