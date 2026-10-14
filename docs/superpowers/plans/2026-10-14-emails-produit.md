# Plan : les e-mails du produit, pilotés depuis /ops (lot 7, 2026-10-14)

Spec : [docs/superpowers/specs/2026-10-14-emails-produit-design.md](../specs/2026-10-14-emails-produit-design.md).

## Méthode de livraison

**Implémenteur par livraison, puis une relecture indépendante de son diff**, parce que ce lot emprunte des chemins de
production qui ne se rappellent pas : des e-mails réels à des clients, un webhook entrant, une migration que la purge
d'un espace nommera, et des points d'émission posés sur le débit du crédit et le passage à l'équipe (un mauvais hook y
enverrait un e-mail par destinataire de campagne). Les critères se vérifient en partie par des tests (dédoublonnage,
signature, désinscription, variables), le reste demande un œil : le rendu dans Gmail et Outlook, le ton des textes.
L'essai réel qui clôt le lot est en bas.

## Livraison A : le socle, les e-mails existants et /ops

1. **Migration, poussée SEULE et appliquée avant le code** (la purge d'espace et le chemin d'envoi la nommeront ; son
   numéro se lit par `npm run migrations` au moment de l'écrire) : les textes modifiés `(clé, langue)`, l'interrupteur
   par clé, le journal des envois (unique sur modèle, espace, personne, clé d'occasion ; statut ; identifiant Resend ;
   index pour les chiffres du mois), les désinscriptions `(identité, catégorie)`, `identities.langue` (`fr` par
   défaut). Noms distincts de `email_templates` (les modèles des clients).
2. **`src/emails-produit/`** : le catalogue (clés, catégories, variables, textes d'origine FR et EN, au vouvoiement),
   le rendu (la mise en page de `renderBrandedEmail` avec un bouton FACULTATIF, une version texte, le pied légal et le
   lien de désinscription selon la catégorie, valeurs échappées), le store, et la fabrique d'envoi unique (garde
   l'identifiant Resend, réessaie 429 et 5xx, `List-Unsubscribe` en un clic).
3. **La file `emails-produit`** dans `BASE_QUEUES`, `QUEUE_POLLING_SECONDS`, `FILES_NOTIFIEES` et `FILES_PAR_ROLE` ;
   l'émission écrit la ligne du journal puis enfile ; le travail relit interrupteur, désinscription et langue avant
   d'envoyer.
4. **Le webhook Resend** (`/webhooks/resend`, classe `signature-service`, entrée dans `FAUSSES_AUTORITES`), signature
   vérifiée avant le corps, `safeParse` ; `RESEND_WEBHOOK_SECRET` vide = la route refuse.
5. **La désinscription** : la route du lien signé (page de confirmation, envoi en un clic), et dans « Mon compte » les
   deux abonnements (commerciaux, transferts) ; la console écrit la langue de la personne.
6. **Les existants passent par le socle** : crédit épuisé (n'est plus marqué avant l'envoi), avis du numéro, annonce du
   Pro ; destinataires = admins actifs déjà connectés (`last_login_at` posé).
7. **`/ops`, section « E-mails »** : routes (liste avec chiffres du mois, texte modifié, rétablir, interrupteur, aperçu,
   essai à l'adresse de l'exploitant), note obligatoire et auteur signé ; la carte tolère l'absence de la route.
8. **Rétention** du journal (13 mois) dans la tâche de rétention, et la purge d'un espace.

## Livraison B : les alertes neuves

1. Crédit sous 0,50 € au débit qui le franchit (clé d'occasion = le dernier crédit reçu).
2. Paiement refusé au premier échec de facture (Pro et numéro fourni), lien du portail Stripe, une fois par facture.
3. Le balayage des limites du Free (rangé dans `TACHES_PAR_ROLE`) : modèles du mois et contacts, 80 % puis 100 % avec
   « Passer en Pro ».
4. Le passage à l'équipe aux trois points d'un robot qui passe la main (agent IA, scénario, agent de Meta), aux admins,
   avec la fin de la fenêtre de 24 h ; jamais un chemin de masse (réponse à une campagne confiée à l'Inbox, réouverture
   par le contact).

## Livraison C : les commerciaux

1. Bienvenue à l'inscription d'un espace.
2. Le balayage des relances (numéro à 24 h, répondeur à 24 h, silence à 7 jours) et du récapitulatif Free (lundi 9 h
   Paris, rien si la semaine est vide), clés d'occasion en base.

## Tests attendus

- Dédoublonnage : deux émissions de la même occasion donnent une ligne et un envoi ; un échec Resend se rejoue.
- Interrupteur, désinscription et langue relus à l'envoi (changés entre l'émission et l'envoi : respectés).
- Le webhook : signature fausse ou absente refusée avant lecture ; un événement inconnu ignoré ; une plainte désinscrit.
- Le lien de désinscription : signé, propre à une personne et une catégorie ; un jeton d'une autre personne refusé.
- Les variables : une inconnue refusée à l'enregistrement ; une valeur avec du HTML échappée au rendu.
- Isolation : les chiffres et le journal d'un espace ne montrent rien d'un autre ; la purge d'un espace efface ses lignes.
- Les destinataires : un admin invité jamais connecté ne reçoit rien ; un agent ne reçoit pas les alertes.
- Aucun chemin de masse n'émet un e-mail de passage (test de garde à côté de ceux des automations).
- Le crédit bas : franchir 0,50 € deux fois sans recharge = un e-mail ; une recharge réarme.
- Les limites : 80 % et 100 % une fois par mois pour les modèles ; un Pro ne reçoit rien.
- L'inventaire : `tests/queue-names.test.ts`, l'auto-attaque (`FAUSSES_AUTORITES`), le registre des tâches par rôle.

## Ordre de déploiement

1. La migration seule : poussée, appliquée en production, relue en base.
2. Livraison A, l'API et le worker, puis la console (`/ops`, « Mon compte ») après l'API.
3. Gestes de Julien avant la livraison B : créer chez Resend le webhook vers `https://api.messagingme.app/webhooks/resend`
   et poser `RESEND_WEBHOOK_SECRET` dans `.env.prod` ; activer le suivi des ouvertures et des clics sur le domaine.
4. Livraison B, puis C, chacune relue et déployée à part.

## L'essai réel qui clôt

Sur un espace de test : recevoir chaque e-mail (crédit bas puis épuisé, paiement refusé avec une carte de test Stripe,
80 % et 100 % des modèles, un passage à l'équipe depuis un téléphone, bienvenue, une relance), en français puis en
anglais ; se désinscrire par le lien puis se réabonner dans « Mon compte » ; modifier un texte dans `/ops`, voir
l'aperçu, envoyer l'essai ; voir les chiffres du mois monter (envoyés, ouverts, cliqués).
