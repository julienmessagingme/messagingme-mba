# Lot 5 du bilan des audits : la traçabilité

Le journal des actions d'un espace (menu Sécurité) ne voit ni plusieurs réglages sensibles du client, ni les gestes que
Messaging Me fait dans un espace depuis `/ops`. Un auditeur demande les deux. La mention « je suis une IA » posée par le
code (l'autre moitié du lot 5) est déjà faite (2026-10-05).

## Ce qui entre au journal

Côté client, l'acteur est la personne connectée :
- une boîte d'envoi e-mail ajoutée, modifiée (dont son mot de passe) ou supprimée : `email.boite_ajoutee`,
  `email.boite_modifiee`, `email.boite_supprimee` ; le détail porte l'hôte, le port et si le mot de passe a changé,
  jamais l'identifiant ni le mot de passe ;
- le canal RCS activé ou désactivé : `rcs.canal_active`, `rcs.canal_desactive` ; jamais la clé ;
- la fréquence de la mention IA réglée : `ia.mention_reglee`, avant et après ;
- le modèle d'un agent changé, sa phrase de mention changée : `agent.modele_change`, `agent.mention_modifiee`, avant et
  après.

Côté exploitation, l'acteur est l'adresse de l'exploitant (comme `mfa.reinitialise`), la cible l'espace :
`ops.offre_posee` (offre, utilisateurs, conservation), `ops.verrou`, `ops.cle_modele_revoquee`, `ops.credit_ajoute`,
`ops.pub_connectee`, `ops.risque_balaye`, `ops.espace_observe`. La note de l'exploitant reste dans le journal du
conteneur : texte libre, elle n'a pas sa place dans une table gardée deux ans (`AUDIT_LOG_RETENTION_DAYS`).

## Tâches

1. Les actions dans `AuditAction` (`src/audit/store.pg.ts`) et leurs libellés dans `web/lib/journal.ts` ; un test qui
   exige un libellé pour chaque action du serveur (aucun ne le tenait).
2. Les modules `email`, `rcs-channel`, `settings` (mention IA) et `agents` reçoivent la dépendance `audit`
   (`AuditSink`, requise, `journalMuet` dans les fixtures) et journalisent APRÈS l'écriture réussie, best-effort
   (`makeJournal`) : une panne du journal ne bloque jamais le réglage.
3. `OpsRouteDeps` et `OpsOffreDeps` reçoivent `tracer(tenantId, par, action, detail)`, câblé sur le même `AuditSink`
   avec l'exploitant pour acteur ; chaque geste l'appelle après son succès, sans le faire échouer.
4. Doc : `documentation.md` (ce que le journal couvre), `features.md` § « Journaux et traces » avec sa fiche d'aide et
   son empreinte, le journal technique.

## Tests attendus

Par module, le geste écrit SA ligne avec le bon acteur et le bon détail, aucune ne porte de secret (mot de passe, clé
RCS), un geste refusé n'écrit rien, un journal en panne ne fait pas échouer le geste. Chaque test vu rouge sans son
branchement. Le test de parité des libellés vu rouge sur une action sans libellé.

## Méthode de livraison

Implémenteur par lot, puis UNE relecture indépendante du diff, parce que les écritures sont sur des chemins que la
production emprunte (chaque réglage, chaque geste d'exploitation) et que le journal garde deux ans ce qu’on y écrit : une
donnée de trop ne s'efface plus. Aucune migration (`audit_log.action` est un `text` libre), donc aucun ordre de
déploiement : l'API, puis la console. L'essai réel qui clôt le lot est décrit ci-dessous.

## Essai réel

Dans l'espace d'essai : régler la mention IA et changer le modèle d'un agent ; depuis `/ops`, observer l'espace. Puis
lire Sécurité > Journal des actions : les trois lignes, le bon acteur, aucun secret.
