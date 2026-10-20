<!-- Version Markdown de https://console.messagingme.app/developers/api/guides/saas-onboarding-activation, générée depuis la page (npm run doc:md). English: https://console.messagingme.app/developers/api/guides/saas-onboarding-activation.en.md -->

# Recette : l’accueil des utilisateurs d’un SaaS

À l’inscription, votre application envoie la bienvenue sur WhatsApp, avec un bouton qui mène à la première action dans votre produit. Elle ne part qu’à l’utilisateur qui a coché la case WhatsApp du formulaire.

<a id="prompt"></a>

## Le prompt à coller

Dans Claude Code, ouvert sur votre projet, avec le serveur MCP de Messaging Me branché. Il renvoie l’assistant vers cette recette : il n’a rien à deviner.

_Prompt_

```
Branche la bienvenue WhatsApp des nouveaux utilisateurs dans ce projet, en suivant la recette
https://console.messagingme.app/developers/api/guides/saas-onboarding-activation.md :
1. installe le SDK : npm install github:julienmessagingme/messagingme-sdk#v0.3.1 ;
2. avec les outils Messaging Me, crée le modèle de bienvenue (MARKETING, le prénom, un bouton URL vers la page qui
   lance l’utilisateur) ;
3. ajoute au formulaire d’inscription une case « Recevoir mes conseils de démarrage sur WhatsApp », non cochée par
   défaut, et écris app/signup.ts qui n’envoie qu’à qui l’a cochée, avec consent opted_in ;
4. range la clé dans les variables d’environnement, jamais dans le code.
N’invente aucune route ni aucun champ : ils sont dans https://api.messagingme.app/openapi.json.
```

<a id="modele"></a>

## Le modèle de bienvenue

Un modèle MARKETING à une variable (le prénom) et un bouton URL vers la page qui lance l’utilisateur. Créez-le par `create_template` (serveur MCP) ou par [POST /v1/templates](https://console.messagingme.app/developers/api/templates.md#creer), puis attendez l’approbation de Meta ; `get_template_status` la confirme.

> **Obligatoire**
>
> Une bienvenue qui invite à utiliser le produit est du marketing pour Meta, pas de l’utilitaire. Un modèle marketing ne part qu’à un contact qui a consenti : sans la case cochée, l’envoi est refusé (no_consent).

<a id="consentement"></a>

## La case de consentement

Ajoutez au formulaire d’inscription une case « Recevoir mes conseils de démarrage sur WhatsApp », non cochée par défaut. L’envoi transmet consent opted_in et la source du consentement : l’API les écrit sur le contact avant le tri des modèles marketing.

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

La bienvenue, appelée une fois le compte créé. Elle part par [POST /v1/sends](https://console.messagingme.app/developers/api/sends.md#envoi), avec une clé d’idempotence tirée de l’utilisateur : rejouée dans les 24 heures, elle n’envoie pas deux fois.

_app/signup.ts_

```
import { messagingme } from '../lib/messagingme';

// Call it once the account exists. The template welcome is MARKETING (it invites to use the product): it only
// goes to someone who ticked the WhatsApp box on the sign-up form. It has one variable, the first name, and a URL
// button to the page that creates the first schedule.
export async function sendWelcome(user: { id: string; phone: string; firstName: string; whatsappOptIn: boolean }): Promise<void> {
  if (!user.whatsappOptIn) return;
  await messagingme.POST('/v1/sends', {
    body: {
      target: { template: { name: 'welcome', language: 'en' } },
      recipients: [{
        phone: user.phone,
        variables: { firstName: user.firstName },
        // The ticked box is the consent: written on the contact before the marketing filter.
        consent: 'opted_in',
        consentSource: 'signup form',
      }],
      params: [{ position: 1, source: { type: 'variable', key: 'firstName' } }],
    },
    // Replayed within 24 hours (the life of the key), the welcome does not send twice.
    idempotencyKey: `welcome-${user.id}`,
  });
}
```

<a id="essayer"></a>

## Essayer

- Inscrivez-vous avec votre propre numéro en cochant la case : la bienvenue arrive, et son bouton ouvre votre application.
- Inscrivez-vous sans cocher la case : rien ne part.
