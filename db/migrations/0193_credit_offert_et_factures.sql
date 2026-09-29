-- 0193_credit_offert_et_factures.sql : le credit offert ne se donne jamais deux fois au meme numero AFFICHE, et
-- chaque achat du journal de credit porte sa session Stripe (le lien « Facture » de la page Credit IA).
--
-- DEUX CHANGEMENTS, TOUS DEUX ADDITIFS, dans la meme migration parce qu'ils partent dans le meme lot.
--
-- 1. LE NUMERO AFFICHE DU CREDIT OFFERT.
--
-- POURQUOI. 0191 bornait l'offre par l'identifiant Meta du numero (phone_number_id). Or un numero retire d'un
-- compte WhatsApp puis rajoute a un autre change tres probablement d'identifiant : le meme numero de telephone,
-- relie a un espace neuf, repartait avec 5 euros (relecture du 2026-09-29). La seconde borne porte donc sur le
-- numero affiche, normalise en E.164 : « + » suivi des seuls chiffres de display_phone_number, que Meta ecrit
-- toujours avec son indicatif. L'expression est celle de src/agent/credits.pg.ts (NUMERO_AFFICHE_SQL), et
-- tests/migration-0193.test.ts compare les deux textes.
--
-- ADDITIVE, DONC AVANT LE DEPLOIEMENT. Une colonne nullable sans defaut, sa reprise, un index unique. L'ancien
-- code n'ecrit pas la colonne : ses lignes la laissent nulle, et un index unique accepte plusieurs nuls. Le code
-- neuf l'ECRIT a chaque offre : deploye avant elle, chaque offre echouerait en 42703.
--
-- LA REPRISE. Les lignes existantes (les numeros marques a zero par 0191, pas retroactif) recoivent le numero
-- affiche de leur numero, s'il existe encore et porte au moins huit chiffres. 🔴 UNE SEULE LIGNE PAR NUMERO : si
-- deux espaces avaient le meme numero affiche sous deux identifiants, la seconde ligne garde null plutot que de
-- faire echouer la construction de l'index, donc la migration entiere. La plus ancienne offre gagne.
--
-- TRANSACTIONNELLE, sans CONCURRENTLY : la table porte une ligne par espace qui a relie un numero, quelques
-- dizaines. Le verrou de construction dure le temps de les lire.
alter table credits_offerts add column if not exists numero_affiche text;

update credits_offerts co
   set numero_affiche = premiers.numero
  from (
    select distinct on (numero) o.tenant_id, numero
      from credits_offerts o
      join phone_numbers pn on pn.id = o.phone_number_id
      cross join lateral (select '+' || regexp_replace(pn.display_phone_number, '[^0-9]', '', 'g') as numero) n
     where pn.display_phone_number is not null
       and length(regexp_replace(pn.display_phone_number, '[^0-9]', '', 'g')) >= 8
     order by numero, o.offert_le, o.tenant_id
  ) premiers
 where co.tenant_id = premiers.tenant_id
   and co.numero_affiche is null;

create unique index if not exists credits_offerts_numero_affiche_uidx
  on credits_offerts (numero_affiche);

-- 2. LA SESSION STRIPE D'UN ACHAT, sur son mouvement (decision de Julien du 2026-09-29 : un lien « Facture » par
-- ligne achat de l'historique). Le lien entre un mouvement et son paiement etait une NOTE (« achat Stripe
-- <offre> (<session>) ») : une phrase ecrite pour l'exploitation, qu'aucun code ne doit relire. La colonne est la
-- donnee ; le webhook l'ecrit dans la transaction qui insere le paiement et credite (PgStripeStore.crediterPaiement).
-- ⚠️ PAS DE CLE ETRANGERE vers stripe_paiements, delibere : les deux lignes naissent dans la meme transaction, et
-- une cle etrangere poserait, a l'application, un verrou et un parcours de validation sur agent_credit_mouvements,
-- la table que chaque tour d'agent ecrit. Aucun index : la seule lecture passe par la cle primaire des paiements.
-- ADDITIVE : l'ancien code ne la lit ni ne l'ecrit (ses achats la laissent nulle, sans lien « Facture »). Le code
-- neuf l'ECRIT a chaque achat, ET a chaque mouvement (l'insertion commune du journal la nomme) : deploye avant
-- elle, chaque debit d'agent et chaque achat echoueraient en 42703.
-- ⚠️ L'ajout de colonne prend un verrou EXCLUSIF, bref (sans defaut, rien n'est reecrit), sur la table que chaque
-- tour d'agent ecrit : il attend les transactions ouvertes sur elle et retient les suivantes pendant ce temps. Lire
-- pg_stat_activity juste avant (aucune transaction longue).
alter table agent_credit_mouvements add column if not exists stripe_session_id text;

-- LA REPRISE, UNE FOIS, PAR LA NOTE : les achats deja credites (un seul en production, refill_50 du 2026-09-29 a
-- 9 h 28 UTC) retrouvent leur paiement par le texte exact que le webhook a ecrit, dans le meme espace.
update agent_credit_mouvements m
   set stripe_session_id = p.session_id
  from stripe_paiements p
 where m.raison = 'achat'
   and m.stripe_session_id is null
   and m.tenant_id = p.tenant_id
   and m.note = 'achat Stripe ' || p.offre || ' (' || p.session_id || ')';
