<!-- Version Markdown de https://console.messagingme.app/developers/api/guides/failed-payment-recovery, générée depuis la page (npm run doc:md). English: https://console.messagingme.app/developers/api/guides/failed-payment-recovery.en.md -->

# Recette : la relance d’un paiement échoué

Quand Stripe signale un paiement échoué, votre application envoie à l’utilisateur un message WhatsApp avec le lien vers sa page de facturation, pour qu’il mette à jour sa carte avant de perdre l’accès.

<a id="prompt"></a>

## Le prompt à coller

Dans Claude Code, ouvert sur votre projet, avec le serveur MCP de Messaging Me branché. Il renvoie l’assistant vers cette recette : il n’a rien à deviner.

_Prompt_

```
Branche la relance WhatsApp des paiements échoués dans ce projet, en suivant la recette
https://console.messagingme.app/developers/api/guides/failed-payment-recovery.md :
1. installe le SDK : npm install github:julienmessagingme/messagingme-sdk#v0.3.1 ;
2. avec les outils Messaging Me, crée le modèle de paiement échoué payment_failed (UTILITY, en, le prénom, un bouton
   URL vers notre page de facturation) ;
3. écris lib/billing.ts relié à Stripe (signature vérifiée) et à nos utilisateurs, et branche l’envoi dans notre
   webhook Stripe app/api/stripe/route.ts, sur invoice.payment_failed, avec une clé d’idempotence par facture ;
4. range les clés et les secrets dans les variables d’environnement, jamais dans le code.
N’invente aucune route ni aucun champ : ils sont dans https://api.messagingme.app/openapi.json.
```

<a id="modele"></a>

## Le modèle de paiement échoué

Un modèle UTILITY à une variable (le prénom) et un bouton URL vers votre page de facturation : une alerte sur le compte de l’utilisateur. Créez-le par `create_template` (serveur MCP) ou par [POST /v1/templates](https://console.messagingme.app/developers/api/templates.md#creer), puis attendez l’approbation de Meta (le code l’appelle payment_failed, en anglais : gardez ce nom et cette langue, ou changez-les dans le code) ; `get_template_status` la confirme.

> **Obligatoire**
>
> Gardez le texte factuel : le paiement, la carte, l’accès. Un modèle que Meta reclasse en marketing ne part plus qu’aux contacts qui ont consenti. Et Meta demande que l’utilisateur ait accepté d’être contacté sur WhatsApp : demandez-le à l’inscription ou dans son compte.

<a id="code"></a>

## Le code

Installez le SDK, puis les variables dans `.env.local` et dans celles de votre hébergeur.

_Commande_

```
npm install github:julienmessagingme/messagingme-sdk#v0.3.1
```

_.env.local_

```
MESSAGINGME_API_KEY=mba_...
MESSAGINGME_WEBHOOK_SECRET=whsec_...
```

_lib/messagingme.ts_

```
import { createClient } from '@messagingme/sdk';

// Server side only: the key must never reach the browser (no NEXT_PUBLIC_ prefix).
export const messagingme = createClient({ apiKey: process.env.MESSAGINGME_API_KEY! });
```

Ce que le cas attend de votre facturation : reliez ces deux fonctions à Stripe et à vos utilisateurs.

_lib/billing.ts_

```
// What this case needs from your billing: Claude Code wires these two functions to Stripe and to your users.
const todo = (what: string): never => { throw new Error(`lib/billing.ts: ${what} is not connected yet`); };

export interface StripeInvoiceEvent { id: string; type: string; data: { object: { id: string; customer: string } } }

/**
 * Stripe’s event with its signature checked: stripe.webhooks.constructEvent on the RAW body (await req.text()), the
 * stripe-signature header and your signing secret. null if invalid.
 */
export async function verifiedStripeEvent(req: Request): Promise<StripeInvoiceEvent | null> { return todo('verifiedStripeEvent'); }
/** The user behind a Stripe customer, if there is one. */
export async function userOfCustomer(customerId: string): Promise<{ phone: string; firstName: string } | null> { return todo('userOfCustomer'); }
```

<a id="stripe"></a>

## Le webhook Stripe

Dans le webhook Stripe que votre application a déjà, sur invoice.payment_failed. L’envoi part par [POST /v1/sends](https://console.messagingme.app/developers/api/sends.md#envoi), avec une clé d’idempotence tirée de la facture : un même événement livré deux fois dans les 24 heures n’envoie qu’un message. Un échec de l’envoi WhatsApp ne change pas la réponse à Stripe, qui sinon réessaierait le webhook puis le désactiverait. Aucune adresse de webhook Messaging Me n’est nécessaire.

_app/api/stripe/route.ts_

```
import { messagingme } from '../../../lib/messagingme';
import { userOfCustomer, verifiedStripeEvent } from '../../../lib/billing';

// Your Stripe webhook, the one you already have. The template payment_failed is UTILITY (an account alert): one
// variable, the first name, and a URL button to your billing page.
export async function POST(req: Request) {
  const event = await verifiedStripeEvent(req);
  if (!event) return new Response(null, { status: 400 });
  if (event.type === 'invoice.payment_failed') {
    const invoice = event.data.object;
    const user = await userOfCustomer(invoice.customer);
    if (user) {
      // A failed WhatsApp send never fails the Stripe webhook: Stripe would retry it, then disable it.
      try {
        const send = await messagingme.POST('/v1/sends', {
          body: {
            target: { template: { name: 'payment_failed', language: 'en' } },
            recipients: [{ phone: user.phone, variables: { firstName: user.firstName } }],
            params: [{ position: 1, source: { type: 'variable', key: 'firstName' } }],
          },
          // Stripe may deliver the same event again: within 24 hours, one message per invoice.
          idempotencyKey: `payment-${invoice.id}`,
        });
        // A refused recipient (STOP, plan limit) is not an error: it is listed in skipped, with its reason.
        if (send.skippedTotal > 0) console.warn(`payment ${invoice.id} not sent: ${send.skipped[0]?.reason}`);
      } catch (e) {
        console.error(`payment ${invoice.id}: WhatsApp send failed`, e);
      }
    }
  }
  return new Response(null, { status: 200 });
}
```

<a id="essayer"></a>

## Essayer

- Avec la CLI de Stripe, déclenchez invoice.payment_failed pour un client relié à votre propre numéro : le message arrive, et son bouton ouvre votre page de facturation.
- Ou envoyez le modèle par `send_template_to_contact` à votre numéro, avant de brancher Stripe.
