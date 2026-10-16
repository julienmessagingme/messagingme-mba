# Les cas d'usage par profil, et le dépôt GitHub qui les rend concrets (lot 6 bis, spec du 2026-10-16)

> Complète [la spec du lot 6](2026-10-15-cas-d-usage-design.md) (pages, anatomie, garde-fous, films) sans la refaire.
> Demande de Julien du 2026-10-16 : partir de ceux qui utilisent Claude Code, Lovable, Cursor, imaginer leurs cas
> d'usage, et enrichir le dépôt GitHub du plugin, « vraiment light », pour que ce que nous faisons soit concret.

## Les décisions de Julien (2026-10-16, deux rondes)

| Sujet | Décision |
|---|---|
| Profils visés | Les quatre : fondateur solo de SaaS, entrepreneur Lovable non technique, agence ou freelance, équipe produit de startup |
| Nouveaux cas | Rappels de rendez-vous anti-absence, accueil et activation d'un SaaS, paiement échoué et relance, agence : dix clients d'un coup |
| Première vague | Les trois cas communs (prise de rendez-vous, réponse aux questions, relais vers un humain), SaaS (accueil, paiement échoué), Lovable (bulle, rappels), agence (dix clients) |
| Dépôt GitHub | Tout : README qui montre, recettes avec code compilé par la CI, une commande du plugin par cas, licence, mots-clés, image d'aperçu |
| Code de connexion par WhatsApp | Au backlog (`todo.md`) : la catégorie « authentification » de Meta n'est pas gérée |

## Les quatre profils, et ce dont ils ont besoin

Sources (souvent publiées par les éditeurs eux-mêmes, donc ordres de grandeur) : le rapport de Lovable (environ 80 %
d'utilisateurs non techniques), le sondage JetBrains 2026 (39 % des développeurs professionnels utilisent Claude Code
au travail), un sondage Pragmatic Engineer relayé (adoption plus forte dans les petites structures).

1. **Le fondateur solo de SaaS** (Claude Code, Cursor) : accueillir et activer ses nouveaux utilisateurs, relancer les
   fins d'essai et les paiements échoués, un support qui répond depuis sa doc, savoir qui a lu.
2. **L'entrepreneur non technique qui construit avec Lovable** (coach, studio, artisan, commerce) : une bulle avec un
   agent qui répond depuis le site, la prise de rendez-vous et les rappels, la collecte de demandes de devis, sans
   écrire de back-end.
3. **L'agence ou le freelance** qui livre des applications à des PME : un module WhatsApp à installer chez chaque
   client, un espace par client, refacturable.
4. **L'équipe produit d'une startup** : notifications transactionnelles, webhooks signés vers son CRM ou son support,
   un agent branché sur son back-end, l'hébergement en Europe.

## Le catalogue, et ce que le produit sait faire

✅ faisable aujourd'hui ; 🟡 en partie (console seulement) ; ❌ manque au produit.

| Cas | Profils | Statut | Briques |
|---|---|---|---|
| Prise de rendez-vous | tous | ✅ | actions de l'agent, `agent.action`, `POST /v1/messages/whatsapp` |
| Réponse aux questions, jour et nuit | tous | ✅ | agent IA, `import_site`, `import_document_text`, bulle |
| Relais vers un humain | tous | ✅ | `set_transfer_mode`, Inbox, `assign_conversation` |
| Accueil et activation d'un SaaS | 1, 4 | ✅ | `POST /v1/contacts`, `POST /v1/sends`, `message.read` |
| Paiement échoué et relance | 1, 4 | ✅ | modèle à bouton lien, `link.clicked` |
| Fin d'essai | 1 | ✅ | `POST /v1/sends` |
| Avis et NPS | 1, 2, 4 | ✅ | modèle, `conversation.analyzed` |
| Bulle et agent sur un site Lovable | 2 | ✅ | `create_widget`, agent IA |
| Rappels anti-absence « Confirmer / Annuler » | 2, 4 | ✅ | modèle à réponses rapides, `message.received` |
| Demande de devis par formulaire WhatsApp | 2, 3 | 🟡 | formulaires de la console, pas encore dans l'API ni le MCP |
| Relance de panier abandonné | 2 | ✅ | modèle marketing, consentement |
| Agence : dix clients, dix espaces | 3 | ✅ | une adresse ouvre plusieurs espaces (`features.md`), le plugin par espace |
| Leads des publicités vers le CRM | 3, 4 | ✅ | publicités Click-to-WhatsApp, intégrations CRM |
| Notifications transactionnelles | 4 | ✅ | `POST /v1/sends`, accusés |
| Code de connexion par WhatsApp | 1 | ❌ | catégorie « authentification » non gérée |

## Les pages : quatre de plus

Mêmes règles que la spec du lot 6 (paire français et anglais, anatomie, `data-*` vérifiés par les tests). Les
adresses se décident ici, une fois :

| Page | Français | Anglais |
|---|---|---|
| 8. Accueillir et activer les utilisateurs d'un SaaS sur WhatsApp | `/cas-d-usage/accueil-activation-saas/` | `/en/use-cases/saas-onboarding-activation/` |
| 9. Relancer un paiement échoué sur WhatsApp | `/cas-d-usage/relance-paiement-echoue/` | `/en/use-cases/failed-payment-recovery/` |
| 10. Les rappels de rendez-vous qui évitent les absences | `/cas-d-usage/rappels-rendez-vous/` | `/en/use-cases/appointment-reminders/` |
| 11. Une agence qui installe WhatsApp chez ses clients | `/cas-d-usage/agence-whatsapp-clients/` | `/en/use-cases/agency-whatsapp-for-clients/` |

Le cas 4 de la spec du lot 6 (support par un agent IA, avec relais à l'équipe) porte les deux cas communs « réponse
aux questions » et « relais vers un humain ».

## Les vagues, revues

| Vague | Cas | Films |
|---|---|---|
| 1 | 1 (rendez-vous), 3 (bulle Lovable), 4 (questions et relais), 8 (accueil SaaS), 9 (paiement échoué), 10 (rappels), 11 (agence) | 1 (fait), 3, 10, un film « SaaS » pour 8 et 9, 11 |
| 2 | 2 (notifications), 5 (leads vers le CRM), 6 (piloter depuis Claude), 7 (campagne) | à décider |

Les tarifs, le carrefour des cas d'usage et la rubrique « Industries » restent ceux du plan du lot 6. Les quatre
profils y deviennent des pages « Pour qui », à valider au plan.

## Le dépôt GitHub du plugin

Il se publie depuis `plugin/` (`DEPLOY.md`, `gh workflow run plugin.yml`, version montée à chaque fois) : tout se fait
chez nous, rien à la main sur GitHub.

1. **Un README qui montre** : le film en tête (lien vers la vitrine, l'image d'aperçu en grand), « ce que vous pouvez
   construire » (un tableau, un lien par recette), l'installation, les phrases à taper dans Claude Code, les outils
   que Claude reçoit, « Free, no subscription », l'API officielle WhatsApp Business.
2. **`recipes/`** : un dossier par cas de la vague 1, avec la phrase à donner à Claude Code, le code obtenu
   (Next.js, Express, Supabase Edge Functions selon le cas) et ce qu'il faut régler dans l'espace. Le code est compilé
   par la CI contre le SDK publié, comme les exemples de la doc (`tests/doc-exemples-compiles.test.ts`) : jamais un
   exemple qui ne marche pas.
3. **Une commande du plugin par cas** (`/messagingme:rendez-vous`, `/messagingme:accueil`,
   `/messagingme:relance-paiement`, `/messagingme:rappels`, `/messagingme:support`, `/messagingme:agence` ; la bulle
   reste dans `/messagingme:demarrer`) : Claude Code branche le cas dans le projet du développeur, avec les vrais
   outils et le SDK. Générées comme les compétences actuelles (`npm run plugin:generer`).
4. **L'hygiène** : `LICENSE` (MIT, déjà déclaré dans `plugin.json`), mots-clés GitHub (`whatsapp`, `whatsapp-api`,
   `mcp`, `claude-code`, `lovable`, `cursor`, `ai-agent`), une image d'aperçu, un `CHANGELOG`. Le dépôt du SDK reçoit
   le même traitement (README avec un lien vers chaque recette, mots-clés).

## À vérifier avant d'écrire le code (le plan le fait en premier)

- La forme d'un clic sur un bouton de réponse rapide dans `message.received` (texte, charge utile) : les rappels en
  dépendent.
- L'autorisation OAuth du plugin quand une adresse a plusieurs espaces : choisit-on l'espace, et peut-on en changer
  dans une même session ? Le cas « agence » en dépend.
- Les catégories de modèle qu'accepte `create_template` pour une fin d'essai et une relance de paiement (utilitaire
  ou marketing, selon la grille de Meta), et ce que Meta facture pour chacune.

## Ce que ce lot ne fait pas

- Le code de connexion par WhatsApp (backlog).
- Les formulaires WhatsApp par l'API ou le MCP (le cas « devis » attend).
- Codex reste soumis à son essai réel avant d'être cité en public (essai 121 de `docs/prive/ESSAIS-REELS.md`).
