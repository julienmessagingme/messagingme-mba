-- 0231 : la raison moyen de paiement du blocage d un compte WhatsApp chez Meta (guide compte Meta, plan
-- docs/superpowers/plans/2026-10-13-guide-compte-meta.md).
--
-- health_status rend can_send_message BLOCKED sans dire pourquoi dans ce que nous gardions. Mesure du 2026-10-13 : un
-- compte sans carte valable porte, sur son entite WABA, l erreur 141006 (moyen de paiement), qui bloque les messages a
-- l initiative de l entreprise (les modeles). Le balayage des statuts et l Accueil l ecrivent ici ; l Accueil et
-- get_setup_state le disent au client. Null = pas encore lu chez Meta, jamais tout va bien.
-- Une colonne nullable sans defaut ne reecrit pas la table. L ancien code ne la lit pas, le nouveau l ecrit : elle
-- passe AVANT le code.
set local lock_timeout = '5s';

alter table phone_numbers add column if not exists waba_paiement_bloque boolean;
