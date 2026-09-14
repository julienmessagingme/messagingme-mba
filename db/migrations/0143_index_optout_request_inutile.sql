-- 0143 : retire `tenant_settings_optout_request_idx`, un index qui ne sert AUCUNE requete.
--
-- 🔴 UN INDEX PARTIEL EST UN CONTRAT AVEC UNE REQUETE PRECISE, ET CELUI-CI N EN AVAIT AUCUNE. La migration
-- 0139 l a cree en annoncant qu il servirait « la question : quelles requetes sont branchees sur le
-- consentement ? posee par la route de suppression avant d accepter d effacer une requete ». Releve en revue
-- du chantier complet, le 2026-09-14 : cette question n est jamais posee ainsi. `brancheeSurConsentement`
-- (`src/index.ts`) lit les REGLAGES DE L ESPACE (`settingsStore.get(tenant)`) et compare l identifiant, donc
-- par la CLE PRIMAIRE de `tenant_settings`. L index n a jamais ete emprunte.
--
-- ⚠️ IL NE COUTAIT PRESQUE RIEN, ET CE N EST PAS LA RAISON DE LE RETIRER. `tenant_settings` porte une ligne
-- par espace : l index tient dans quelques pages. Ce qu on retire, c est une JUSTIFICATION FAUSSE inscrite
-- dans le schema. Le prochain lecteur aurait cru qu une requete le sert, et aurait pu elargir un `where` en
-- croyant rester dans son contrat. Une justification fausse est pire qu aucune, parce qu elle sera recopiee.
--
-- ⚠️ ELLE NE RETIRE QU UN INDEX, donc l ancien code y survit sans rien changer : aucune requete ne le
-- nommait. Elle peut passer AVANT comme APRES le deploiement, et elle passe avant, avec les autres.

drop index if exists tenant_settings_optout_request_idx;
