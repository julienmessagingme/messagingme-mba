# Le tunnel du numéro dans la console et le plugin (2026-10-30)

Suite de `2026-10-30-tunnel-numero-generique.md` : la vitrine pose l'arbre de Julien depuis `010b721b`, la console et le
plugin posent encore l'ancien (et le QR code). Textes de référence : `scripts/vitrine/tunnel-textes.ts`.

## L'arbre, partout le même

1. **L'offre.** Dans la console, l'espace l'a déjà : la page commence à la question 2. Dans Claude, `get_setup_state` et
   la demande collée la disent souvent ; sinon Claude la pose.
2. **Avez-vous un compte Meta Business ?** Oui : numéro API, libre (`apporte`) ou fourni (`fourni`), avec « Vous pouvez
   la garder » vers l'application. Non, ou « Je ne sais pas » (avec où vérifier) : question 3.
3. **Avez-vous déjà l'application WhatsApp Business ?** Oui : la garder (`coexistence`). Non : la télécharger, y mettre
   son numéro, et brancher tout de suite en la gardant.

Plus aucune voie par QR code (filière `application`) proposée, ni par la console, ni par Claude, ni par la doc. Le code
de la filière reste, pour les espaces déjà reliés ; leur suite est de garder l'application par Meta, sur le même numéro.

🔴 Le numéro trop neuf : Meta refuse dans SA fenêtre, que Claude ne voit pas. La skill le reconnaît à ce que la
personne lui rapporte (rien à deviner côté code) et propose de revenir dans quelques jours, sans chiffre. Le message
exact (relevé par des revendeurs, jamais mesuré chez nous) et ce que la fenêtre envoie à la page (`[ES] message reçu`
dans la console du navigateur) se mesurent à l'essai 198 ; si la page reçoit un refus lisible, le faire remonter à
`watch_whatsapp_connection` est un lot suivant.

## Tâches

1. Console : `web/lib/questions-numero.ts` (textes, deux langues) et `ParcoursNumero` qui pose les questions 2 et 3
   avant les choix ; `tests/questions-numero-vitrine.test.ts` les tient égales à la vitrine ; e2e mis à jour.
2. Plugin : skill `mise-en-service`, skill `shopify`, README, FAQ (`scripts/plugin/faq.ts`, `npm run plugin:generer`),
   version montée.
3. Ce que Claude lit côté serveur : `start_whatsapp_connection` (la description de `filiere`), les suites de
   `watch_whatsapp_connection` d'un espace relié par QR code ; la doc MCP de la console (`web/lib/mcp-outils.ts`,
   `npm run doc:md`). Les courriels et les refus d'envoi des espaces déjà reliés par QR code restent au `todo.md`, avec
   la question du retrait de la filière.
4. Fiches d'aide `garder-mon-application-whatsapp-business` (la voie « télécharger ») et
   `connecter-mon-numero-whatsapp` (la question avant « Fournissez-moi un numéro »), `features.md`, `todo.md`, journal.

Ordre : un push (la console part par Vercel, aucune route neuve), le déploiement de l'API, `aide:charger`, puis la
publication du plugin.

## Méthode de livraison

**En direct**, sans agent, parce que le lot est fait de textes et d'un écran sans route neuve : réversible d'un `git
revert`, aucun envoi ni écriture en base, et ses critères mécaniques (mêmes questions que la vitrine, plus de « QR code »
proposé, noms de code de la skill connus, FAQ et doc égales à leur génération) se tiennent par des tests. Une relecture
indépendante en fin de lot, parce que `ParcoursNumero` porte des reprises invisibles (retour de Stripe, numéro déjà
attribué, lien de Claude qui arrive avec son choix) que les questions ne doivent pas casser.

Essai réel qui clôt la feature : l'essai 198, étendu à la console et au plugin 0.3.17 : les trois voies depuis la page
« Connecter WhatsApp » et depuis `/messagingme:demarrer`, puis un numéro NEUF par « télécharger l'application », la
console du navigateur ouverte pour relever ce que Meta répond.
