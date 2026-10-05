# Lot 3a : le pont du code et la réserve, plan

Spec : `docs/superpowers/specs/2026-10-05-pont-du-code-design.md`. Plan court : tâches, interfaces, tests attendus,
ordre de déploiement.

## Méthode de livraison

**Implémenteur par lot + revue humaine du diff**, une relecture indépendante en fin de lot : une route publique signée
et une migration, deux chemins que la production emprunte, et une signature qui porte des invariants invisibles
(comparaison en temps constant, fraîcheur, chemin signé). Aucun workflow multi-agents.

**L'essai réel qui clôt** : un numéro neuf déclaré dans /ops, ajouté dans le WhatsApp Manager en méthode « Appel », et
le code dicté par Meta affiché dans /ops en moins d'une minute, sans aucun guetteur lancé à la main.

## Tâches

1. **Migration 0210 `numeros_fournis`** : les deux tables de la spec (§ 3), leurs CHECK nommés, les clés étrangères
   (`tenant_id` en `set null`, `numero_id` en cascade), l'unicité de `numero`, `didww_did_id` et `appel_id`.
   Magasin `src/otp/store.pg.ts` : `declarer`, `lister` (avec le dernier code par numéro), `parNumero`, `ecrireCode`
   (idempotent sur `appel_id`), `purgerAvant`. Tests d'intégration en CI : les CHECK, l'idempotence, l'isolation.
2. **L'extraction** passe dans `src/otp/extraire-code.ts` et apprend l'anglais (chiffres, mots, « oh » pour zéro) ;
   `src/zadarma/` l'importe de là. Tests : les formes anglaises, l'unanimité, les cas français existants inchangés.
3. **Le client DIDWW** `src/didww/client.ts` : `trouverDid(numero)`, `brancher(didId, trunkId)`, réponses en
   `safeParse`. Configuration : `DIDWW_API_KEY`, `DIDWW_TRUNK_OTP_ID`, `OTP_PONT_SECRET` (vides par défaut ; sans
   secret, la route du pont n'est pas montée ; sans clé, la déclaration rend 503).
4. **La route du pont** `src/http/otp-pont.ts`, classe `signature-service` :
   `POST /internes/otp/appels/:numero/:appel`, corps `audio/wav` (analyseur limité à cette portée, 4 Mo), signature
   `x-mm-service-signature` vérifiée par `verifyRequest` (le schéma entre nos services) AVANT tout. Numéro inconnu :
   404. Transcription sur la clé maison, extraction, écriture, 200. Entrée au registre et fausse autorité de
   l'auto-attaque. Tests : signature absente, fausse, périmée, chemin modifié ; numéro inconnu ; code trouvé ;
   transcription en échec ; aucun code certain ; redélivrance.
5. **/ops** : module `opsNumeros` (`session-ops`), `GET` et `POST /ops/numeros-fournis` (note signée comme les autres
   écritures de /ops) ; section « Numéros fournis » de la console. Tests : refus sans session d'exploitation, numéro
   absent de DIDWW, déclaration en double, la liste avec le dernier code.
6. **La purge** : une étape du balayage de rétention, sept jours.
7. **L'Asterisk dans le dépôt** : `ops/otp-asterisk/` (`docker-compose.yml`, `extensions.conf`, `envoyer-otp.sh`,
   `pjsip.conf.example`), le script signant au format de `signRequest`. Test : le script et `signRequest` produisent
   la même signature sur un vecteur fixe.

## Ordre de déploiement

1. CI verte job par job, relecture sans rouge.
2. Julien pose la clé DIDWW de production (commande prête à coller) ; le secret du pont est généré sur le VPS.
3. Migration 0210 AVANT le `up` de l'API et des deux workers, relue en base juste après.
4. La console (section /ops) part avec le push : elle doit tolérer l'absence de la route, ou être poussée après le `up`.
5. L'Asterisk : le script et le plan de numérotation posés sur le VPS, conteneur recréé (fichiers montés seuls).
6. **Essai réel** : un numéro neuf déclaré dans /ops, ajouté dans le WhatsApp Manager en méthode « Appel », le code
   affiché dans /ops en moins d'une minute.
