# Plan : le guide « compte Meta », première condition (2026-10-13)

Décisions de Julien du 2026-10-13 (plan privé, « Décisions du 2026-10-13 ») : avant de connecter un numéro, un
compte Meta Business (le portefeuille d'entreprise, accessible par un profil Facebook ou un compte Meta géré) ; un
numéro qui ne sert pas dans l'application WhatsApp ; après la connexion, la carte chez Meta (Visa ou Mastercard),
sans laquelle les modèles ne partent pas. Dit PARTOUT : Claude Code l'annonce sans poser de question, la page
« Connecter WhatsApp » avant la fenêtre de Meta, un bandeau de l'Accueil tant que la carte manque, une fiche du bot
d'aide, la vitrine et la FAQ. Pas-à-pas complet chez nous, une seule source pour tous.

Mesuré le 2026-10-13 en lecture seule : `primary_funding_id` est réservé aux BSP (erreur 10) ; `health_status` se lit
et rend, sur un compte sans carte valable, `can_send_message: BLOCKED` avec l'erreur 141006 (« There is an error
with the payment method. This will block business initiated conversations »). Quatre comptes sur quatre l'avaient.

## Méthode de livraison

**En direct, une relecture, essai réel.** Le chemin de production touché est la lecture de la santé du compte (le
balayage des statuts du worker et l'Accueil) et une colonne neuve : réversible, sans envoi ni montant. Les critères
se testent (la raison 141006 lue, le drapeau écrit, l'avertissement rendu, les étapes affichées depuis la source
unique). L'essai qui clôt : un espace sans carte chez Meta voit le bandeau sur l'Accueil et l'avertissement dans
`get_setup_state`, puis le perd une fois la carte posée (au plus 20 minutes, le pas du balayage).

## Tâches

1. **Migration 0231** : `phone_numbers.waba_paiement_bloque boolean` nullable (null = inconnu). Poussée SEULE et
   appliquée AVANT le code, qui l'écrit.
2. **La raison du blocage** : `getWabaHealth` (`src/meta/phone-number.ts`) lit aussi les erreurs de l'entité WABA de
   `health_status` ; `paiementBloque` vaut vrai si l'une est un code de paiement (`CODES_PAIEMENT_META`, 141006).
   Le pull (`src/account/pull.ts`) le transporte, `saveStatus` l'écrit, le balayage et l'Accueil le rafraîchissent.
3. **L'Accueil** : la réponse du statut du compte porte `paiementMetaBloque` ; un bandeau « Ajoutez votre carte chez
   Meta » avec le pas-à-pas, tant qu'il vaut vrai.
4. **`get_setup_state`** : l'avertissement `carte_meta_a_regler` quand le numéro connecté est bloqué pour paiement.
5. **La source unique** (`web/lib/partage/etapes-meta.ts`) : `PREREQUIS_META` (le compte Meta Business, le numéro
   libre) et `ETAPES_CARTE_META` (le chemin du Gestionnaire WhatsApp), en français et en anglais. Lue par la page
   « Connecter WhatsApp » (encadré « Avant de commencer »), le bandeau de l'Accueil et la consigne de
   `start_whatsapp_connection` et `get_setup_state`.
6. **La skill et la FAQ** (plugin 0.1.4) : la skill annonce les prérequis avant le lien, rappelle la carte dès la
   connexion et lit l'avertissement ; deux entrées de FAQ (« Que faut-il chez Meta ? », « Mes modèles ne partent
   pas »), régénérées sur la vitrine et dans `llms.txt`.
7. **La vitrine** : une ligne de prérequis sur la section développeurs, en français et en anglais.
8. **Le bot d'aide** : la section de `features.md` et une fiche neuve, « Ce qu'il faut chez Meta ».

## Tests attendus

- La raison lue depuis un `health_status` réel (le corps mesuré), absente sur un compte disponible, et tolérée quand
  Meta rend une chaîne.
- Le drapeau écrit par `saveStatus` (vrai, faux, null qui ne remplace rien).
- L'avertissement `carte_meta_a_regler` de `etatMiseEnService`, et son absence sans numéro connecté.
- La page, le bandeau et la consigne lisent la même source (un test du type `tests/etapes-numero-fourni.test.ts`).
- La FAQ régénérée, la fiche et son empreinte (`tests/aide-proposer.test.ts`), les noms de la skill.

## Ordre de mise en ligne

1. Migration 0231 poussée seule, CI, appliquée et relue en base.
2. Le code (API, worker, console, plugin, vitrine) en un commit, relu, CI verte job par job.
3. `up` de l'API et des workers, `aide:charger`, nginx, fumée ; la console part avec le push (elle tolère l'absence
   du champ) ; puis le plugin 0.1.4.
