# Les e-mails du produit, pilotés depuis /ops (lot 7, 2026-10-14)

## Le besoin

Le produit prévient ses clients par e-mail de ce qui demande un geste (crédit, numéro, limites, une conversation qui
attend l'équipe) et accompagne ceux qui démarrent (bienvenue, relances, récapitulatif). Julien maîtrise tout depuis
`/ops` : les textes, un aperçu, un essai, un interrupteur par e-mail et les chiffres du mois. Tout part de l'app, par
Resend, sans HubSpot.

Aujourd'hui : Resend appelé en direct, sans file, sans journal ni suivi ; trois e-mails clients automatiques (crédit
épuisé, avis du numéro fourni, annonce de la suite du Pro) en plus de l'invitation et du mot de passe oublié ; un
paiement refusé ne prévient que Julien (Telegram). Le crédit marque sa journée AVANT d'envoyer (un échec n'est jamais
rejoué) et les invitations pas encore acceptées reçoivent les alertes.

## Décisions de Julien (grill du 2026-10-14)

- **Alertes de service** (crédit, numéro, limites) : aux admins qui se sont déjà connectés, jamais coupables.
- **Conversation passée à l'équipe** : aux admins seulement, un e-mail par passage, avec le temps qui reste dans la
  fenêtre de 24 h de Meta.
- **Langue** : celle de la console de chaque personne, retenue côté serveur ; chaque modèle a une version française et
  une anglaise.
- **Crédit bas** : sous 0,50 €, une fois, réarmé à chaque recharge ; puis l'e-mail « épuisé » existant.
- **Relances** : numéro pas connecté 24 h après l'inscription ; numéro connecté depuis 24 h sans répondeur (ni agent IA
  actif ni agent de Meta) ; aucun message reçu ni envoyé 7 jours après la mise en service. Une fois chacune.
- **Récapitulatif de la semaine** : au Free seulement, lundi 9 h (Paris), rien si la semaine est vide.
- **Offre Pro** : dans l'alerte à 100 % d'une limite du Free (bouton « Passer en Pro »), pas d'e-mail à part.
- **Désinscription** : un lien coupe tous les commerciaux de la personne ; l'e-mail de transfert a son propre lien. Les
  alertes partent toujours.
- **Format** : du texte en paragraphes avec des variables proposées, plus un bouton facultatif (libellé et lien), dans
  la mise en page Messaging Me. Aucun HTML à écrire.
- **Existants** : crédit épuisé, avis du numéro et annonce du Pro passent dans le système modifiable ; l'invitation et
  le mot de passe oublié restent dans le code (un lien d'accès ne dépend pas d'un texte modifiable).
- **Paiement refusé** : un e-mail au premier échec (Pro ou numéro fourni), avec le lien du portail Stripe ; Telegram
  reste.
- **Suivi** : ouvertures et clics sur tous les e-mails, activés chez Resend sur `messagingme.app`.

## La conception

**Le catalogue est dans le code, les textes en base.** Chaque e-mail a une clé, une catégorie (`service`, `transfert`,
`commercial`), ses variables permises et ses textes d'origine FR et EN. La base ne garde que ce que Julien a modifié ;
« Rétablir le texte d'origine » supprime la ligne. Une variable inconnue est refusée à l'enregistrement, jamais à
l'envoi. Toute valeur est échappée au rendu.

**Le journal est aussi le dédoublonnage.** Chaque envoi voulu écrit d'abord une ligne `(modèle, espace, personne,
clé d'occasion)`, unique en base (« crédit bas, cet espace, cette recharge », « limite des modèles à 80 %, ce mois »,
« passage, cet événement ») ; un doublon s'arrête là, puisque aucune file du dépôt ne dédoublonne. La ligne porte le
statut (`a_envoyer`, `envoye`, `echec`, puis `livre`, `ouvert`, `clique`, `rebond`, `plainte`) et l'identifiant
Resend. Elle désigne la personne (`identities`), jamais son adresse en clair, et part avec l'espace à sa suppression.

**Une file du worker envoie.** Un seul point construit le client Resend ; il garde l'identifiant rendu, réessaie un 429
ou un 5xx avec attente, et pose `List-Unsubscribe` (avec l'envoi en un clic) sur les commerciaux et les transferts. Il
relit l'interrupteur, la désinscription et la langue AU MOMENT d'envoyer. Un échec reste `echec` et se rejoue.

**Le webhook signé de Resend** met le journal à jour par l'identifiant Resend (signature vérifiée avant de lire le
corps, `safeParse`). Une plainte désinscrit la personne des commerciaux.

**Les détecteurs :**
- crédit bas : au débit qui fait passer le solde sous 0,50 €, la clé d'occasion étant le dernier crédit reçu (une
  recharge réarme sans état de plus) ;
- paiement refusé : à l'échec de facture que Stripe signale, une fois par facture ;
- limites du Free : un balayage compare l'usage à la limite (modèles du mois, contacts) ; 80 % puis 100 %, une fois par
  mois pour les modèles, une fois par franchissement pour les contacts ;
- passage à l'équipe : aux trois points qui écrivent `escaladee` ou `passee_par_mba` pour un robot qui passe la main
  (agent IA, scénario, agent de Meta) ; le nom du contact s'il est connu, sinon le numéro masqué, l'heure de fin de la
  fenêtre, le lien vers la conversation ; JAMAIS le texte des messages ;
- bienvenue à l'inscription ; relances et récapitulatif par un balayage, avec leur clé d'occasion en base (un drapeau en
  mémoire se perd au redémarrage).

**La langue** est une colonne de l'identité (`fr` par défaut), écrite par la console à la connexion et quand la personne
change de langue.

**La désinscription** passe par un lien signé (personne et catégorie), sans connexion ; « Mon compte » montre les deux
abonnements et permet de les rétablir.

**`/ops`, section « E-mails »** : la liste des modèles par catégorie avec leurs chiffres du mois (envoyés, échecs,
ouverts, cliqués), l'interrupteur, l'édition FR et EN (sujet, texte, bouton, variables proposées, note obligatoire),
l'aperçu rendu, l'essai envoyé à l'adresse de l'exploitant connecté. Chaque écriture signe sa trace de son auteur.

## Hors champ

- L'invitation et le mot de passe oublié (restent dans le code, hors des chiffres).
- Les e-mails envoyés aux contacts des clients (boîtes SMTP des espaces) : rien ne change.
- Un sous-domaine d'envoi séparé, un éditeur HTML, des préférences fines par type d'alerte.
