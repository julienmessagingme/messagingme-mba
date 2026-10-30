# Le Crédit WhatsApp : payer ses messages chez Messaging Me, sans carte chez Meta (spec du 2026-10-30)

> Une option des offres Pro et Business (et de l'Entreprise sur demande, facturée après coup) : le client ne pose pas de
> carte chez Meta, la ligne de crédit d'un Solution Partner de Meta (« le partenaire ») paie ses messages, et le client
> les prépaie chez nous sur un solde, le **Crédit WhatsApp**. Cadrée avec Julien les 29 et 30 octobre 2026 en quatre
> rondes de questions, puis relue à froid par un constructeur qui n'avait que ce document (ses cinq questions sont
> tranchées ici). La
> mécanique Meta vient de la doc lue le 2026-10-29 (Multi-Partner Solutions, partage de ligne de crédit, analytics,
> tarification) : **lue, pas éprouvée**, c'est le lot 0 qui l'éprouve, avant toute ligne de code.
>
> **Le partenaire n'est nommé ni ici ni sur aucune surface du produit** (décision : jamais nommé chez nous ; le dépôt est
> public). Son nom, ce qu'on sait de lui et les questions à lui poser : `docs/prive/PARTENAIRE-LIGNE-DE-CREDIT.md`, non
> versionné.
>
> Dans ce document, **décision** = tranché par Julien ; **choix de Claude** = un défaut proposé, à relire.

## Ce que veut Julien

Laisser un client Pro ou Business payer ses messages WhatsApp chez nous plutôt que de poser une carte sur son compte chez
Meta, grâce à la ligne de crédit du partenaire. Sans avancer l'argent : le client achète du crédit à l'intérieur de la
console, comme le crédit IA, et chaque message le consomme. L'exigence qui commande tout le reste : **maîtriser le coût
cumulé des messages consommés** (marketing, utility, authentification, service), puisque Meta facture le partenaire,
qui nous facture.

## Comment ça marche chez Meta (lu le 2026-10-29, pas éprouvé)

- **Le modèle de compte a changé le 2026-09-23.** Le numéro vit dans un « compte WhatsApp » ; chaque partenaire a son
  « compte de messagerie » (l'ancien WABA ID), qui porte modèles, facturation, moyen de paiement, analytics et webhooks.
  Chaque message est facturé au compte de messagerie qui l'envoie (`messaging_account_id` à l'envoi), et un compte qui
  porte la ligne d'un partenaire est fermé aux autres partenaires.
- **L'embarquement** se fait par une Multi-Partner Solution (MPS) : nous en Tech Provider, le partenaire en Solution
  Partner. Notre fenêtre Embedded Signup reçoit `extras: { setup: { solutionID }, featureType: '', sessionInfoVersion:
  '3' }`. Aucun écran de la fenêtre ne demande de moyen de paiement ; le partenaire attache sa ligne APRÈS l'embarquement
  (`whatsapp_credit_sharing_and_attach`, `waba_currency=EUR`). À la création de la solution, on désigne l'appli qui
  envoie (« Only me » : nous).
- **La ligne ne se détache plus** : une fois attachée, changer de moyen de paiement demande un nouveau compte de
  messagerie. La révocation (par le partenaire) frappe TOUS les comptes du client partagés avec lui ; ensuite, l'envoi
  rend 131042.
- 🔴 **Meta ne nous donne pas le coût.** `pricing_analytics` ne rend pas `COST` sur un compte qui partage la ligne d'un
  Solution Partner (« will not be returned for Messaging accounts that share a Solution Partner's credit line »), seulement
  `VOLUME`, par `COUNTRY`, `PHONE`, `PRICING_CATEGORY`, `PRICING_TYPE` et `TIER`, à la demi-heure, au jour ou au mois.
  L'objet `pricing` d'un accusé ne porte aucun montant. Le coût, c'est nous qui le recalculons.
- **Un accusé ne revient qu'à l'appli qui a envoyé.** Un envoi fait sur le compte de la ligne sans passer par nous ne se
  voit que dans les volumes de Meta.
- **Tarification** : un message est facturé à la livraison, selon l'indicatif du destinataire et la catégorie ; Meta
  publie ses grilles par devise, EUR comprise, et les change au 1er jour d'un trimestre avec un mois de préavis. Paliers
  de volume (utility, authentification) comptés par portefeuille propriétaire, par marché et par catégorie, sur le mois
  civil. Franchise : 1 000 messages de service livrés par mois et par numéro, sans report.
- **L'agent de Meta** n'est pas facturé sur la ligne d'un partenaire d'après 360dialog et CM.com (Meta ne le dit pas) :
  une facture Meta à part, par numéro.

## Ce que fait le code aujourd'hui (le delta, relevé le 2026-10-29)

- **Le crédit IA** : solde en micro-euros, journal `agent_credit_mouvements` (0087, `src/agent/credits.ts`), garde à
  l'entrée du tour (le solde peut finir légèrement négatif), achat Stripe Checkout à 5, 10, 50 ou 100 € HT crédité par
  le webhook une fois par session (`src/http/credit-stripe.ts`, `src/stripe/traitement-recharge.ts`), historique de 90
  jours avec lien « Facture », alertes sous 0,50 € puis à zéro. Sa commission vit dans `DROITS` (`commissionPct`,
  `src/offres/offres.ts`) et il pilote le plafond chez Vercel (`remonterPlafondApresRecharge`).
- **`tarifs_meta`** (0163) garde le `pricing` de chaque accusé sortant (type, catégorie, facturable), par espace et wamid.
- **`MetaPricingClient`** (`src/meta/pricing.ts`) lit `COST` et `VOLUME` de `pricing_analytics` pour les écrans de coût,
  avec la grille de `/ops` (`GrillePrix`, `src/stats/prix.ts` : marge, service à 2,48 cts, franchise de 1 000) et
  `coutMessages` (`src/stats/cout-messages.ts`).
- **Le blocage pour moyen de paiement** : 141006 lu dans `health_status` (`src/meta/phone-number.ts`), écrit dans
  `phone_numbers.waba_paiement_bloque` (0231), bandeau de l'Accueil, avertissement `carte_meta_a_regler` de
  `get_setup_state`, textes `PREREQUIS_META` et `ETAPES_CARTE_META` (`web/lib/partage/etapes-meta.ts`).
- **La connexion** : `web/lib/connexion-numero.ts` et `web/lib/fenetre-meta.ts` (Embedded Signup v4, `config_id`,
  `extras`), `src/http/embedded-signup.ts` côté serveur. Le marketing part par la MM API depuis le 2026-10-14
  (invariant 54), selon `marketing_messages_onboarding_status`.
- **Stripe** : l'abonnement du Pro et ses sièges (`src/stripe/sieges.ts` : Stripe d'abord, la limite ensuite, prorata
  en `pending_if_incomplete`), l'abonnement du numéro fourni, les achats du crédit IA. Le Business n'a aucun objet Stripe
  (spec du 2026-10-27).
- **L'inventaire des chemins d'envoi** : `tests/optout-chemins.test.ts`, dérivé des méthodes d'envoi de
  `src/meta/client.ts`. Les pauses de campagne : `src/campaign/pause.ts` (`numero_suspendu`).

## L'option

- **Son nom face au client : « Crédit WhatsApp »** (décision), à côté du « Crédit IA » dans la page Offre. Le bouton de
  connexion dit **« Connecter sans carte chez Meta »** (décision).
- **Qui y a droit** : le Pro et le Business, par un **objet Stripe qui débloque la connexion** (décision ; c'est la seule
  exception à « aucun objet Stripe » de la spec Business) ; l'Entreprise sur demande, posée par Julien dans `/ops`, sans
  Stripe et **en open bar** : ni solde, ni achat, ni garde, Julien facture après coup ce que dit le coût recalculé
  (décision, voir « L'Entreprise ») ; **jamais la Free** (décision), qui la voit grisée avec « avec le Pro » (décision).
- **Prix : 30 € HT par numéro et par mois** (décision). Choix de Claude sur la forme : un abonnement Stripe mensuel à
  part (il doit vivre en Business, qui n'a pas d'abonnement Pro), dont la quantité est le nombre de numéros autorisés
  sur la ligne. Comme les sièges : Stripe d'abord, le bouton ensuite ; un ajout facture le prorata sur le coup et ne
  s'applique que si cette facture est payée ; un retrait vaut à la fin de la période, sans remboursement.
- **Sans essai** (choix de Claude) : payée tout de suite, même par un Pro en essai, puisque la ligne nous expose dès la
  connexion.
- **Fin** (choix de Claude, après la relecture à froid) : quand plus aucune offre de l'espace n'y donne droit (fin du
  Pro, Business ou Entreprise retirés dans `/ops`, fin de l'essai du Business), l'abonnement Stripe de l'option se
  résilie de lui-même, sans remboursement du mois entamé : c'est son propre objet, pas un geste sur le Business, et on ne
  facture pas une option inutilisable. Nos envois sur ces numéros s'arrêtent le jour même ; la ligne reste attachée 30
  jours, pour qu'un client qui revient reprenne sans reconnexion. Sur impayé, les envois s'arrêtent quand Stripe
  abandonne ses relances, pas au premier échec (l'enjeu est de 30 €, les messages restent prépayés). La suite est celle
  de « La sortie ».

## Le Crédit WhatsApp (le solde)

- **Un solde distinct du crédit IA** (décision) : son journal, ses achats, son historique. Un seul par espace, partagé
  par tous ses numéros sur la ligne (choix de Claude). Le crédit IA, son plafond chez Vercel et sa commission ne bougent
  pas.
- **Achats** : 50, 100, 250 ou 500 € HT (choix de Claude) par Stripe Checkout, en euros, TVA ajoutée, facture émise par
  Stripe, crédit plein, crédité par le seul webhook signé, une fois par paiement, comme le crédit IA.
- **Jamais remboursé, n'expire pas, gardé quand l'option s'arrête**, et il resservira si elle revient (décision).
- **Aucun crédit exigé pour se connecter** (décision : la connexion d'abord, les envois attendent le premier achat).
- **Recharge automatique dès la v1** (décision), **sans plafond** (décision). Choix de Claude sur la forme : un
  administrateur l'active avec un seuil et un montant (parmi les quatre) ; elle débite la carte que Stripe garde pour
  l'abonnement de l'option, par une facture Stripe (même trace qu'un achat) ; un paiement refusé ou qui demande une
  authentification l'éteint et prévient par e-mail avec le lien de la facture. Garde technique, qui n'est pas un plafond :
  **une seule recharge en vol par espace**, pour qu'une rafale d'envois ne débite pas la carte plusieurs fois pour le même
  seuil. Une campagne qui coûte plus que le solde, recharge automatique active, est **rechargée avant le départ**
  (décision) : une seule facture prélève ce qui manque, arrondi au multiple supérieur du montant de recharge choisi, et
  la campagne part une fois le solde couvert ; un paiement refusé laisse la campagne non lancée, avec la raison.
- **Alertes** (choix de Claude, sur le modèle du crédit IA) : e-mail aux administrateurs et bandeau sous 10 € HT (une
  fois par recharge), puis à zéro (une fois par jour au plus), quand la recharge automatique est éteinte ou a échoué.

## L'Entreprise : open bar, facturée après coup (décision)

« Pour l'Entreprise on gère tout à la main » : ni Crédit WhatsApp à acheter, ni recharge, ni garde de solde ; on part du
principe qu'il y a du crédit, et Julien facture après coup. Choix de Claude sur la forme : les envois d'un numéro
Entreprise sur la ligne passent sans contrôle de solde, mais leur coût se recalcule exactement comme ailleurs (provision,
ajustement, régularisation), et `/ops` donne par mois ce qu'il y a à facturer (coût Meta recalculé plus la commission de
l'espace). Pas d'onglet Crédit WhatsApp pour l'Entreprise en v1, pas de coupure à -50 € ; un envoi hors Messaging Me
détecté est signalé dans `/ops` et facturé avec le reste.

## Le prix d'un message

- **Le coût réel recalculé, franchise déduite, plus 5 % de commission** (décisions). Le client paie ce que Meta aurait
  facturé à sa propre carte : la franchise de 1 000 messages de service par numéro et par mois est offerte (Meta l'offre),
  les messages que Meta ne facture pas (fenêtre gratuite d'une publicité, exemption) ne coûtent rien. Choix de Claude :
  les paliers de volume sont répercutés aussi, puisque c'est le coût réel.
- **La commission** : 5 % pour toutes les offres (décision), jamais affichée en taux (décision de la spec Business,
  qui vaut ici), une valeur réglable dans `/ops` sans déploiement, et négociable par espace pour l'Entreprise comme la
  commission IA (choix de Claude).
- **La grille de Meta par pays** (décision) : la grille en euros que Meta publie, tous pays, toutes catégories (dont
  l'authentification internationale) et ses paliers, avec la correspondance indicatif / marché de Meta, chargée dans
  `/ops` par Julien et datée. Meta la change au 1er d'un trimestre avec un mois de préavis : `/ops` signale une grille
  plus vieille que le trimestre en cours (choix de Claude). Un indicatif que la grille ne place nulle part tombe dans le
  marché « autres » de Meta.
- **Le client voit les prix**, commission comprise et jamais son taux, dans l'onglet Crédit WhatsApp et dans
  l'estimation d'une campagne (choix de Claude).
- **L'agent de Meta est géré à part** (décision) : il reste permis sur un numéro de la ligne, hors de l'option, facturé
  par Meta comme aujourd'hui ; la console le dit au moment du choix. Le lot 0 mesure si sa facture à part exige une
  carte, si cette carte gêne la ligne, et si ses réponses entrent dans les volumes du compte. La régularisation ne compte
  jamais comme envoi hors Messaging Me une réponse de l'agent que nous avons vue passer (origine `mba`), sinon on
  couperait un client pour son propre agent (choix de Claude).

## La maîtrise du coût, en trois étages

1. **Une garde avant chaque envoi, sur chaque numéro de la ligne hors Entreprise** (décision : tout s'arrête à zéro,
   réponses comprises, humains et agent IA). Un envoi ne part que si le solde couvre sa **provision** : le prix de la grille pour
   le pays et la catégorie, au premier palier, commission comprise ; zéro pour un message de service encore dans la
   franchise du numéro selon notre propre compte du mois (choix de Claude). La provision se prend atomiquement : deux
   envois simultanés ne passent pas sur le même centime. La garde est une **dépendance requise** de chaque interface
   d'envoi, et un inventaire dérivé du code (comme `tests/optout-chemins.test.ts`) refuse un chemin d'envoi qui ne la
   déclare pas : campagnes, scénarios, automations, agent IA, Inbox, API publique, MCP, Shopify. Un envoi refusé dit
   pourquoi ; dans l'Inbox, avec le lien de recharge pour un administrateur.
   - **Campagne** (décisions) : au lancement, l'estimation (destinataires × provision) ; si elle dépasse le solde, refus
     avec « il vous manque X € », ou, recharge automatique active, recharge avant le départ (voir le solde). En route, un
     solde épuisé met la campagne en pause (`credit_whatsapp_epuise`), et elle repart seule après la recharge.
2. **L'ajustement à l'accusé** (choix de Claude) : chaque provision est rattachée à son wamid ; un accusé qui dit « non
   facturable » la rend, un échec la rend, une catégorie différente (Meta a reclassé le modèle) la corrige. Un message
   gratuit mais inconnu d'avance (fenêtre d'une publicité) est donc provisionné puis rendu ; à solde nul, il est refusé
   (accepté en v1).
3. **La régularisation sur les volumes de Meta** (choix de Claude sur la cadence : à l'heure, consolidée chaque jour) :
   `pricing_analytics` en `VOLUME` sur le compte de la ligne, par pays, catégorie, type, palier et numéro ; le coût
   recalculé (volumes facturés × grille au palier lu × commission) se compare à ce qu'on a débité pour la même période,
   et l'écart devient une **ligne de régularisation** (crédit ou débit). Elle rattrape les paliers, les messages jamais
   délivrés, les reclassements et les envois hors Messaging Me. **La fraîcheur réelle de ces volumes se mesure au lot 0.**
   - **Envois hors Messaging Me** (décision : débités, puis coupure) : des volumes facturés par Meta au-delà de nos
     propres envois sont débités par la régularisation, avec un e-mail au client et une alerte dans `/ops`. Nos envois
     s'arrêtent déjà à zéro ; si le solde passe sous **-50 €**, Julien fait retirer la ligne par le partenaire, ce qui
     coupe tous les comptes du client chez lui et oblige à reconnecter le numéro sur un nouveau compte. L'Entreprise n'a
     ni solde ni coupure : l'envoi est signalé et facturé.
- **Une vue dans `/ops`** (choix de Claude) : par espace sur la ligne, le solde, le coût Meta recalculé du mois, ce qui
  a été débité et régularisé, les envois hors Messaging Me détectés, les numéros sur la ligne et l'option payée, et pour
  l'Entreprise le montant du mois à facturer. Pas de
  rapprochement avec la facture du partenaire, ni de suivi de son plafond (Julien : hors de mon sujet).

## L'entrée : le tunnel et la connexion

- **Le guide du numéro** (page Shopify, centre d'aide, écran « Connecter WhatsApp », ce que dit Claude), après le choix
  de l'offre : une question **« Qui règle Meta ? »**, deux cartes, chaque bouton sous sa carte : « Ma carte chez Meta »
  et « Crédit WhatsApp : vous prépayez vos messages chez Messaging Me, 30 € HT par numéro et par mois ». En Free, la
  seconde est grisée avec « avec le Pro » (décisions). La réponse suit le visiteur jusqu'à la console comme les autres
  réponses du guide (choix de Claude).
- **La page « Connecter WhatsApp »** (et la zone de l'Accueil) montre les deux mêmes cartes. Sans option, la carte
  Crédit WhatsApp mène au paiement Stripe de l'option (une place de plus) ; au retour, le bouton « Connecter sans carte
  chez Meta » est débloqué (décision). Un espace Free y voit « avec le Pro » et le chemin vers le Pro.
- **La fenêtre de Meta** s'ouvre avec l'identifiant de la solution. Choix de Claude, côté serveur : l'identifiant ne
  part que vers un espace qui a une place payée et libre ; `/embedded-signup/complete` ne relie un numéro « sur la
  ligne » que si cette place existe, et le marque comme tel (les autres numéros ne sont pas concernés par la garde).
- **La ligne s'attache à notre demande** (choix de Claude, condition à poser au partenaire) : après la vérification du
  paiement, jamais d'office pour quiconque ouvrirait la fenêtre avec l'identifiant de la solution. « Ligne active » se lit
  comme aujourd'hui sur la santé du compte : 141006 disparaît quand la ligne est attachée (déduit, prouvé au lot 0).
  Jusque-là, les envois attendent avec un message clair.
- **Une garde quel que soit le mode d'attache** (choix de Claude, après la relecture à froid) : l'identifiant de la
  solution finit forcément dans le navigateur d'un client, qui pourrait rouvrir la fenêtre de Meta depuis un espace sans
  option. Tout compte trouvé sur la ligne sans place payée chez nous voit ses envois par Messaging Me refusés, et `/ops`
  le signale pour que Julien fasse retirer la ligne. Le moyen de le repérer se mesure au lot 0 : la liste du partenaire,
  ou l'absence de `COST` dans `pricing_analytics`, qui trahit un compte sur la ligne d'un partenaire.
- **Pas de coexistence en v1** (choix de Claude) : « Garder mon application WhatsApp Business » n'est pas proposé avec
  le Crédit WhatsApp, Meta ne documente pas la combinaison. Un numéro fourni par nous est compatible. Un numéro
  360dialog ne l'est pas (sa facturation est ailleurs).
- **Nouvelles connexions seulement** (décision) : un numéro déjà connecté avec sa carte ne passe pas sur la ligne en v1.

## La sortie (décision : à la main en v1)

Quand l'option s'arrête pour un numéro (résiliation, impayé, fin du Pro ou du Business, coupure) : nos envois sur ce
numéro s'arrêtent, la console dit pourquoi et quoi faire (reconnecter le numéro avec sa carte chez Meta, sur un nouveau
compte de messagerie, ses modèles resoumis avec l'aide de Julien). Le Crédit WhatsApp reste. Choix de Claude : la
révocation frappant tous les comptes du client chez le partenaire, Julien ne la demande que quand plus aucun numéro de
l'espace n'est sur la ligne (reconnexion faite, ou 30 jours après la fin de l'option) ; d'ici là, notre garde et la
détection des envois hors Messaging Me tiennent le numéro arrêté.

## Ce que le changement casse ailleurs (rayon de souffle)

- 🔴 **Les écrans de coût afficheraient « gratuit ».** `parsePricing` lit `Number(p.cost) || 0` : sans `COST`, un espace
  sur la ligne aurait un tarif nul par catégorie. Sur la ligne, ces écrans lisent la grille (lot 1).
- 🔴 **Le bandeau « carte Meta à régler » dirait au client d'ajouter une carte.** Sur un numéro de la ligne, 141006 veut
  dire « ligne pas encore attachée » (ou retirée) : autre texte, alerte dans `/ops`, et `get_setup_state` suit. Une carte
  posée par le client pourrait même faire refuser la ligne (rapporté par Twilio).
- `PREREQUIS_META` et la consigne de `start_whatsapp_connection` parlent de la carte : une variante pour la ligne.
- Les phrases et fiches qui disent « Meta vous facture » (coexistence, fiche `ce-qu-il-faut-chez-meta`, FAQ du plugin)
  suivent pour un espace sur la ligne.
- Les numéros de la ligne envoient sur LEUR compte de messagerie : un numéro qui en aurait plusieurs doit nommer le bon
  à l'envoi (`messaging_account_id`, vérifié au lot 0).

## Le partenaire face au client

**Jamais nommé chez nous** (décision) : ni écran, ni e-mail, ni fiche d'aide, ni vitrine, ni réponse de Claude ; il
n'apparaît que dans la fenêtre de Meta et dans le portefeuille du client. Il n'est pas nommé dans ce dépôt public non
plus : « le partenaire » dans le code et les docs (choix de Claude, comme pour Brevo). Seule exception possible, légale :
s'il traite des données personnelles (abonnement aux webhooks des comptes), il entre dans la liste des sous-traitants de
notre DPA. À trancher par Julien quand le partenaire aura répondu.

## Claude, l'aide, la vitrine, les docs

- **MCP** (choix de Claude) : `get_credit` montre aussi le Crédit WhatsApp d'un espace qui a l'option ; `buy_credit`
  prend le solde visé (IA ou WhatsApp) et rend le lien de paiement ; l'option elle-même se prend dans la console en v1.
- **Vitrine dès la livraison** (décision) : une ligne « Crédit WhatsApp » sur les cartes Pro et Business, « sur demande »
  en Entreprise, une entrée de FAQ, la question du guide ; l'anglais se régénère par ses dictionnaires ; le rendu
  (bureau et téléphone) est montré à Julien avant le push.
- **Aide** : une fiche publique « Payer ses messages sans carte chez Meta » (donc une page de la vitrine) ; la FAQ du
  plugin (`scripts/plugin/faq.ts`), version montée, publiée après l'API.
- **Docs du dépôt** : `features.md` (et les empreintes des fiches liées), `documentation.md`. **Hors code, pour Julien** :
  les conditions générales (prix = coût Meta recalculé plus commission, crédit non remboursé, débit des envois hors
  Messaging Me, coupure sous -50 €) avant l'ouverture.

## Les lots, dans l'ordre (choix de Claude)

0. **Hors code, avant tout** : l'accord et la MPS créée avec le partenaire (Julien), puis un essai manuel sur un espace
   de test. Fenêtre de Meta avec l'identifiant de la solution, aucune carte demandée, ligne attachée (délai mesuré),
   141006 qui disparaît, un modèle envoyé et délivré, accusés avec `pricing`, `pricing_analytics` en `VOLUME` (`COST`
   absent, fraîcheur mesurée), MM API `ONBOARDED` ou non, `messaging_account_id`, l'agent de Meta sur un compte de la
   ligne (carte exigée ou non, ses réponses dans les volumes ou non), le repérage d'un compte sur la ligne, une
   révocation essayée sur un compte jetable. Et les réponses du partenaire aux questions de la note privée. Rien ne se
   code avant.
1. **Le solde et la garde**, invisibles du client : la grille dans `/ops`, le Crédit WhatsApp (journal, provisions par
   message, ajustement aux accusés), la garde sur tous les chemins d'envoi avec son inventaire et le mode open bar de
   l'Entreprise, l'estimation et la pause des campagnes, les écrans de coût sur la grille.
2. **La régularisation** : les volumes de Meta, le recalcul, les lignes de régularisation, la détection des envois hors
   Messaging Me, l'e-mail, la vue de `/ops`.
3. **L'option et l'entrée** : l'abonnement Stripe de l'option (Pro, Business), sa résiliation à la fin de l'offre, et
   `/ops` (Entreprise), les achats, la recharge automatique et la recharge avant une campagne, l'onglet Crédit WhatsApp et
   ses alertes, la page « Connecter WhatsApp » et le guide, la fenêtre avec l'identifiant de la solution, la garde de
   rattachement et celle des comptes sur la ligne sans place payée, « ligne active », les textes de 141006, la sortie.
4. **Vitrine, aide, plugin, docs**, ouverts le même jour que le lot 3 (décision : dès la livraison).

## Méthode de livraison proposée pour le plan

**Implémenteur par lot + revue humaine du diff** : la production emprunte ces chemins (chaque envoi, chaque accusé, un
montant débité, un paiement) et ils portent des invariants invisibles (provision et régularisation qui se compensent
sans double débit, idempotence des paiements, une seule recharge en vol). **Essai réel qui clôt la feature** : un vrai
numéro de test embarqué sur la ligne, une recharge Stripe en mode live, une campagne de quelques messages vers la France
et un autre pays, le solde débité au bon prix, la régularisation du lendemain égale aux volumes de Meta multipliés par la
grille, un envoi refusé à zéro, une recharge automatique déclenchée, puis la première facture du partenaire comparée par
Julien.

## Ce qui ne change pas

Le chemin « ma carte chez Meta », qui reste le défaut ; le crédit IA ; la Free ; l'agent de Meta et sa facturation ; les
numéros déjà connectés et les numéros 360dialog ; une réponse dans la fenêtre de 24 h n'est jamais bloquée par l'OFFRE
(règle de la spec Business), elle l'est par un Crédit WhatsApp vide, et seulement sur un numéro de la ligne.

## Hors du périmètre (v1)

- La bascule d'un numéro déjà connecté (décision) et la sortie automatisée (décision).
- La coexistence (choix de Claude).
- Les conditions du partenaire, son plafond global, le rapprochement avec sa facture (Julien).
- Un plafond de recharge automatique (décision) ; un solde, des achats ou une recharge pour l'Entreprise (décision :
  open bar, facturée à la main) ; un montant libre.
- Le RCS (hors Meta).

## Ce qui ferait échouer le projet même s'il marche

- Un message parti par nous sur un numéro de la ligne sans crédit pour le couvrir.
- Un client débité deux fois pour le même message (provision et régularisation non compensées).
- Une option payée qui ne débloque pas le bouton, ou une fenêtre qui ouvre la ligne sans option payée.
- Le partenaire nommé sur une surface que voit le client.
- Un écran de coût qui affiche « gratuit » pour un espace sur la ligne, ou une console qui lui dit d'ajouter une carte.
- Une recharge automatique qui débite deux fois pour le même seuil franchi.
- Un compte sur la ligne, relié sans place payée, qui envoie par nous sans garde.
- Un client coupé à cause des réponses de son propre agent de Meta.
