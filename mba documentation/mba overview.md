# Meta Business Agent overview


## What is Meta Business Agent

Meta Business Agent is an enterprise AI agent that engages your customers on WhatsApp in your brand's voice. Once enabled, it acts as the primary responder — answering questions from your business knowledge, taking actions through your own systems (such as looking up an order or booking an appointment), and handing off to your app when needed.

You set up, configure, and enable the agent through the Meta Business Agent Platform APIs. When you're ready to build, see [Get started](https://developers.facebook.com/documentation/meta-business-agent/get-started).

## What you can do

You configure what your agent knows, how it responds, and what actions it can take — plus handoff to your app whenever you need to step in.

- **What it knows** — add business information, FAQs, websites, and files so the agent answers from your content.
- **How it responds** — define skills that set the agent's tone, priorities, and brand voice.
- **What it can do** — connect your own APIs and set up webhook subscriptions so the agent can take actions and listen to events, such as booking an appointment or confirming a payment.
- **Handoff** — pass control between the agent and your app for specific events or flows.
- **Testing** — send test messages and evaluate the agent's performance before and after you go live.

For the full list of APIs and how they fit together, see [Get started](https://developers.facebook.com/documentation/meta-business-agent/get-started).

## Availability

Meta Business Agent is available only in approved countries and verticals. Only businesses based in an approved country can onboard, so you can use the platform if you support businesses that operate in the following countries and verticals:

**Verticals:** Automotive, Consumer Packaged Goods (CPG), Professional Services, Retail and Ecommerce, and Travel

**Countries:** (182 supported)

Albania; Algeria; Andorra; Angola; Anguilla; Antigua and Barbuda; Argentina; Armenia; Aruba; Australia; Austria; Azerbaijan; Bahamas; Bahrain; Belgium; Belize; Benin; Bermuda; Bhutan; Bolivia; Bonaire, Sint Eustatius and Saba; Bosnia and Herzegovina; Botswana; Brazil; British Indian Ocean Territory; British Virgin Islands; Brunei; Bulgaria; Burkina Faso; Burundi; Cameroon; Canada; Cape Verde; Cayman Islands; Central African Republic; Chad; Chile; Colombia; Comoros; Costa Rica; Croatia; Curaçao; Cyprus; Czech Republic; Côte d'Ivoire; Democratic Republic of the Congo; Denmark; Djibouti; Dominica; Dominican Republic; Ecuador; Egypt; El Salvador; Equatorial Guinea; Estonia; Eswatini; Falkland Islands; Finland; France; French Guiana; Gabon; Gambia; Georgia; Germany; Ghana; Greece; Greenland; Grenada; Guadeloupe; Guatemala; Guernsey; Guinea; Guinea-Bissau; Guyana; Honduras; Hong Kong; Hungary; Iceland; India; Indonesia; Iraq; Ireland; Isle of Man; Israel; Italy; Jamaica; Jersey; Jordan; Kenya; Kosovo; Kuwait; Laos; Latvia; Lebanon; Lesotho; Liberia; Libya; Liechtenstein; Lithuania; Luxembourg; Madagascar; Malawi; Malaysia; Maldives; Mali; Malta; Martinique; Mauritania; Mauritius; Mayotte; Mexico; Moldova; Monaco; Mongolia; Montenegro; Montserrat; Morocco; Mozambique; Namibia; Nepal; Netherlands; New Zealand; Nicaragua; Niger; Nigeria; North Macedonia; Norway; Oman; Pakistan; Panama; Paraguay; Peru; Poland; Portugal; Puerto Rico; Qatar; Republic of the Congo; Romania; Rwanda; Réunion; Saint Helena; Saint Kitts and Nevis; Saint Lucia; Saint Martin; Saint Vincent and the Grenadines; San Marino; Saudi Arabia; Senegal; Serbia; Seychelles; Sierra Leone; Singapore; Sint Maarten; Slovakia; Slovenia; South Africa; Spain; Sri Lanka; Suriname; Sweden; Switzerland; São Tomé and Príncipe; Taiwan; Tajikistan; Tanzania; Timor-Leste; Togo; Trinidad and Tobago; Tunisia; Turkey; Turkmenistan; Turks and Caicos Islands; U.S. Virgin Islands; United Arab Emirates; United Kingdom; United States; Uruguay; Uzbekistan; Vatican City; Venezuela; Zambia; Zimbabwe

To check whether a specific phone number is eligible programmatically, use the [Eligibility](https://developers.facebook.com/documentation/meta-business-agent/reference/onboard/agent-eligibility) endpoint.

## Requirements

To use Meta Business Agent, you need:

- A WhatsApp Business Account with a WhatsApp Business phone number
- A Meta app with the **whatsapp_business_messaging** permission
- A business that operates in a [supported country and vertical](#availability)

For the full setup walkthrough, see [Get started](https://developers.facebook.com/documentation/meta-business-agent/get-started).

## Pricing

Meta Business Agent messages are priced differently from other WhatsApp message types. For current rates and details, see [WhatsApp pricing for non-template messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/non-template-messages).