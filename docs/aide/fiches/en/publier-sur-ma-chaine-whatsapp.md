---
slug: post-on-my-whatsapp-channel
traduit_de: a1af06
description: Post on your WhatsApp Channel from Messaging Me: the message, the photo, the “Chat” button that starts a scenario, and what can be measured.
---
# Post on my WhatsApp Channel

A WhatsApp Channel broadcasts to followers, one way only: they receive, they do not reply. What it brings in the
console is **bringing the follower back into a conversation**: each post can carry a “Chat” button that opens
WhatsApp with a message already written, and this message triggers a scenario.

**Write the message.** A text box, a preview that shows the post as the follower will see it, and a formatting
bar: bold, italic, strikethrough, plus a palette of emojis. The emoji is inserted at the cursor, and formatting
applies to the selection, which stays in place so you can chain two styles. Formatting uses WhatsApp syntax and
goes out as is: the follower’s phone renders it, and the preview shows you the expected result, never the stars.

**Add a photo.** The “Choose an image” button uploads from your computer, the console hosts the file and fills in
the address by itself. The address field stays available if you already host your visuals elsewhere. 2 MB maximum,
in JPEG, PNG or GIF: the file’s real type is checked, a renamed file is refused.

**The “Chat” button** is attached to a **link**, which pairs a **phrase** with a **scenario**. The phrase is what the
follower will send by tapping. Three rules govern it, and they show at creation: a phrase can neither contain nor
be contained in the phrase of another link or of a WhatsApp widget (“Promo!” and “Promo?” count as the same phrase),
otherwise a single tap would start two scenarios; the console counts how many existing messages already contain it,
to spare you a phrase that is too common (“Hello” would trigger on everything); finally, a phrase cannot start with
a stop word (“stop”, “unsubscribe”…), otherwise every follower who tapped would be unsubscribed.

**A tap takes back control of the thread.** If the conversation was held by an operator or by Meta’s agent, the
button’s scenario starts anyway and control goes back to the application. It is the same principle as a campaign:
someone made an explicit move, here the follower themself. An ordinary keyword, on the other hand, does not take
control back: a person in the middle of answering a customer must not be cut off by a scenario on a mere message.

**The list of posts** shows, for each post: its formatted text, its date, its status read live from the provider,
the scenario its button leads to, and how many people sent its button’s message. A dead button is flagged, with
its fix next to it.

**“How many clicks” does not exist, and it is not a gap in the console.** A tap on the button opens WhatsApp on the
follower’s phone: this move goes through no server, neither ours nor the channel’s. What can be measured is the
message that arrives next. The screen therefore shows exactly what it observes, “N people sent this message”,
counted as distinct people: a follower who taps three times counts as one.

Three limits are written under the list, rather than tucked away in a tooltip:

- the figure is for the **button**, all its posts combined. Two posts on the same button send the same message,
  nothing says which one was seen;
- a message received while the button was off is counted, without having started anything;
- when the measure is unavailable, the screen shows **nothing** rather than a zero, which would read “this button
  produced nothing”.

Nor does this figure say “conversations started”, and that is deliberate: we only recognise the button’s phrase,
while three more conditions then decide whether a scenario really starts.
