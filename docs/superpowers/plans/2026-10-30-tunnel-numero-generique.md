# Le tunnel du numéro WhatsApp, générique et partout (2026-10-30)

Consigne : l'arbre dessiné par Julien le 2026-10-30, à reprendre tel quel. Le tunnel de la page Boutiques Shopify (offre,
puis choix entre le numéro relié par code et le numéro API) était incompréhensible pour les visiteurs, et il ne servait
qu'aux boutiques. Julien, le même jour : « on supprime une bonne fois pour toutes l'option QR code ».

## L'arbre

1. **Quelle offre ?** Free ou Pro (une aide repliée sous « Je ne sais pas »).
2. **Avez-vous un compte Meta Business ?** (l'ancien Business Manager)
   - Oui : issue **numéro API** (numéro libre, ou numéro fourni : `PRIX_NUMERO_AFFICHE_HT_CENTIMES` en Free, inclus dans
     le Pro), avec la ligne « Votre numéro est déjà dans l'application WhatsApp Business ? Vous pouvez la garder ».
   - Non : question 3.
   - Je ne sais pas : question 3, avec où le vérifier (business.facebook.com, la publicité Facebook ou Instagram).
3. **Avez-vous déjà l'application WhatsApp Business ?**
   - Oui : issue **garder l'application** (le numéro y reste et envoie aussi depuis Messaging Me).
   - Non : issue **télécharger l'application**, y mettre son numéro et le brancher tout de suite en la gardant ; si Meta
     refuse un numéro trop neuf, revenir quelques jours plus tard (précision de Julien du 2026-10-30, aucun chiffre).
4. **Au bout**, par offre : en Free, le plugin, son dépôt et la demande à coller dans Claude Code ou Codex ; en Pro,
   « Créer mon espace », le pas-à-pas et la même demande. La demande reprend les réponses et s'adapte à la page d'origine
   (générique, Shopify, SaaS) ; les questions, elles, sont les mêmes partout.

Interdits face au visiteur : « QR code », « coexistence », toute voie qui ne fait que répondre, « boutique » dans les
questions. Quand la voie de l'application crée le compte Meta Business, la page le dit.

## Tâches

1. Module partagé `scripts/vitrine/tunnel.ts` (rendu) et `tunnel-textes.ts` (textes, deux langues, demandes par page
   d'origine) ; `boutique.ts` et `boutique-textes.ts` le consomment au lieu de leur guide.
2. Page « Démarrer » (`/demarrer/`, `/en/get-started/`), générée par `npm run vitrine:cas` ; `?offre=free|pro` répond à
   la première question à l'ouverture (`site.js`).
3. Le même tunnel sur la page SaaS builders (`pagesCarrefour`).
4. Bouton « Démarrer » dans l'en-tête (gabarits, `npm run vitrine:entete`) ; Tarifs : « Démarrer gratuitement » et
   « Démarrer avec le Pro » vers le tunnel avec l'offre choisie ; l'Accueil y mène (dictionnaires anglais à jour).
5. `sitemap.xml`, `llms.txt`, `JUMELLES` (anglais.ts), tests : `tests/vitrine-tunnel.test.ts` reprend ceux du guide de la
   page Shopify et les étend à chaque page qui porte le tunnel.

## Méthode de livraison

**En direct**, sans agent, parce que le lot ne touche que la vitrine statique : réversible d'un `git revert`, aucun chemin
de production de l'API, et ses critères mécaniques (arbre sans boucle, mots interdits, prix lus dans le code, boutons de
chaque issue, pages égales à leur génération) se tiennent par des tests. Ce qu'un test ne voit pas, la lisibilité du
tunnel, se juge à l'œil : rendu montré à Julien au bureau et au téléphone, dans les deux langues, et son oui AVANT le push
(face publique nouvelle).

Essai réel qui clôt la feature : un visiteur suit les trois voies sur la page en ligne, colle la demande dans Claude Code,
et le branchement aboutit, dont la voie « télécharger l'application » avec un numéro neuf, pour savoir si Meta le refuse
(à inscrire dans `docs/prive/ESSAIS-REELS.md`).
