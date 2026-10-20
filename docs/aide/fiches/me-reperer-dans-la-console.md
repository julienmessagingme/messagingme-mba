---
source_section: Navigation (trois onglets en haut, barre latérale par onglet)
source_empreinte: 586a76
publique: oui
rubrique: demarrer
rang: 4
---
# Me repérer dans la console

Trois onglets en haut de l'écran, et le menu de gauche change avec l'onglet. Ils rangent trois métiers qui ne se
pratiquent ni au même moment ni par les mêmes personnes : configurer, traiter les conversations, lire les
résultats.

**1. Console, pour tout ce qui se règle.** C'est l'onglet de la configuration : vos contacts, vos campagnes, vos
scénarios, vos agents, vos contenus et vos outils.

Son menu : Accueil, mini-CRM, Campagnes, Chaîne, Publicités, Automation, AI Agent (MBA, qui ouvre les paramètres de
l'agent de Meta ; Other AI agent, qui ouvre vos agents IA), Contenu (rangé par canal : WhatsApp avec les Templates
et les Formulaires, RCS avec les Messages, Email avec les Modèles, puis le Scénario et la Bibliothèque avec vos
blocs, vos étiquettes et vos champs) et Tools (Webhooks, Connecteurs API, Connecteurs MCP, SMTP email pour la boîte
qui envoie vos e-mails, Widget WhatsApp). Collés en bas de la barre, parce qu'ils ne servent pas le travail
quotidien mais le règlent : **Paramètres** (Général, Crédit IA pour recharger le crédit de l'espace, Médiathèque,
Offre), **Support**, **Sécurité** (Consentement, IA, Audit trails, Journal des erreurs) et **Developers**
(Documentation API, Clés d'API, Serveur MCP, Webhooks sortants).

**2. Inbox, pour répondre.** Cet onglet n'a aucune barre de navigation : il porte son propre menu de dossiers, à
la manière d'une boîte mail.

**3. Performance Lab, pour lire les résultats.** Synthèse, Quantitatif (Messages & contacts, Coûts, Funnel),
Analyse des conversations et Mes tableaux.

**4. Le menu Compte, en haut à droite.** Il porte ce qui vous concerne vous plutôt que votre espace : la bascule
de langue, Mon compte (pour changer votre mot de passe), Compte & équipe et la déconnexion.

Pour un administrateur, **Abonnement** montre l'offre de l'espace (Free, Pro ou Entreprise) et ouvre la page
Offre, et **Billing** ouvre le portail de Stripe, où vous retrouvez vos factures.

**La bascule FR/EN change toute l'interface**, y compris les dates, les nombres et les pourcentages. Elle est
mémorisée par navigateur, elle vaut donc pour vous et pas pour vos collègues, et elle est aussi disponible avant
de vous connecter.

**5. Les Paramètres, en bas de la barre.** Paramètres > Général porte le fuseau horaire de votre espace et vos
heures d'ouverture ; Paramètres > Crédit IA montre le crédit prépayé de l'espace, permet à un administrateur de
le recharger, et liste ce qui l'a fait bouger.

Les heures d'ouverture se règlent jour par jour, avec une heure de début, une heure de fin, ou « fermé ». C'est la
base sur laquelle s'appuient toutes les conditions de temps de vos scénarios et l'option qui limite une campagne à
vos heures d'ouverture. Quand la promesse de transfert de vos agents IA suit vos heures d'ouverture, ce sont aussi
elles qui décident de ce qu'ils annoncent en passant la main ; depuis Claude Code, Claude peut les régler pour vous.
Les horaires s'enregistrent d'eux-mêmes, sans bouton, moins d'une seconde après chaque modification : à côté du
titre, « enregistré » vous le confirme, et en cas d'échec un « réessayer » renvoie la semaine. Un jour dont l'heure
de fin précède l'heure de début est signalé en rouge, et rien n'est enregistré tant qu'il n'est pas corrigé. Un
manager n'y voit qu'un seul réglage, celui qui autorise vos agents à prendre eux-mêmes une conversation.

**Bon à savoir.** En offre Free, la console se réduit à l'essentiel : l'Accueil (votre numéro, et comment piloter
l'espace depuis Claude Code, Cursor ou l'API), les Clés d'API, la documentation de l'API et du serveur MCP, l'Offre,
votre Compte et le Support. Les autres écrans restent visibles, grisés : ils s'ouvrent avec l'offre Pro. En
attendant, tout ce qu'ils font se demande à Claude ou se fait par l'API.

Les groupes qui contiennent plusieurs écrans se replient d'un clic sur leur en-tête. Ils s'ouvrent d'office quand
vous êtes sur une de leurs pages. Chaque écran garde son adresse propre : vous pouvez la mettre en favori ou
l'envoyer à un collègue, elle rouvre la même page.

**Un opérateur ne voit qu'un onglet, l'Inbox.** Lui en montrer trois dont deux le renverraient aussitôt à l'Inbox
serait lui promettre deux portes fermées.
