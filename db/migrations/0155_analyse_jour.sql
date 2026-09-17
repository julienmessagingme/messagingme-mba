-- 0155_analyse_jour.sql : ce qu'on GARDE d'une journee quand son contenu est efface.
--
-- 🔴 CETTE TABLE EXISTE PARCE QUE LA RETENTION DESCEND A 90 JOURS, et elle est la contrepartie exacte de
-- cette perte. Supprimer une conversation supprime son analyse EN CASCADE : sans ces lignes, la Synthese se
-- viderait a la meme vitesse que l'Inbox, et une periode « 12 mois » ne montrerait plus rien au-dela de
-- trois. Le client perdrait la memoire de son activite en meme temps que le contenu de ses echanges, alors
-- qu'il n'a demande a perdre que le second.
--
-- 🔴 AUCUNE DONNEE PERSONNELLE, ET C'EST CE QUI AUTORISE A LA GARDER. Ni numero, ni texte, ni resume, ni
-- identifiant de conversation : rien qui permette de remonter a quelqu'un. C'est exactement la doctrine deja
-- appliquee a `workflow_node_events`, qu'on ANONYMISE au lieu de supprimer pour que les compteurs restent
-- justes. Une table d'agregats qui porterait un identifiant de contact serait une conservation deguisee, et
-- le RGPD ne se contourne pas par un `group by`.
--
-- 🔴 DES SOMMES ET DES COMPTES, PAS DES MOYENNES, et ce choix decide de la justesse de tout l'ecran. Une
-- moyenne stockee ne se re-agrege PAS : regrouper sept journees moyennes sans leur poids donne une moyenne
-- de moyennes, qui est fausse des que les journees n'ont pas le meme nombre de mesures (une journee a 1
-- mesure de 9 et une a 9 mesures de 3 font 3,6, pas 6). En gardant la SOMME et le COMPTE, la moyenne se
-- recalcule a n'importe quelle maille, exactement.
--
-- ⚠️ `mesurees` N'EST PAS `conversations`, ET LES DEUX SONT LA POUR CA. Les notes de satisfaction et
-- d'urgence sont neuves depuis la migration 0121 : une journee peut porter cinquante conversations et zero
-- mesure. Diviser par `conversations` compterait des analyses qui n'ont pas de note et tirerait la moyenne
-- vers le jour le plus bavard plutot que vers le plus mesure.
--
-- ⚠️ PAS DE REPARTITION DE « QUI A REPONDU », ET C'EST DELIBERE. Le cadrage la promettait ; aucun ecran ne la
-- lit. Les badges « qui a repondu » sont un detail PAR CONVERSATION, et ce detail disparait avec le contenu
-- qu'on efface : un compte agrege n'a aucun consommateur. La colonne s'ajoutera le jour ou un ecran la
-- demandera, pas avant. C'est le motif « une capacite livree sans personne pour la lire », que ce depot paie
-- assez souvent pour ne pas le refaire volontairement.
--
-- 🔴 LA CLE PRIMAIRE EST `(tenant_id, jour)`, ET ELLE REND LE BALAYAGE IDEMPOTENT. Le balayage recalcule
-- TOUTES les journees encore presentes a chaque passage, en `on conflict do update` : il peut donc etre
-- rejoue, interrompu, relance, sans jamais produire de doublon ni d'etat partiel. C'est ce qui permet de le
-- faire tourner AVANT la purge au demarrage du worker et d'en finir avec l'ordre.
--
-- ⚠️ AUCUN INDEX EN PLUS, DELIBEREMENT. La seule lecture est « les journees de cet espace entre deux
-- dates », que la cle primaire sert deja. Un index de plus serait une ecriture payee a chaque passage du
-- balayage pour une requete qui n'existe pas, et un index partiel est un contrat avec une requete precise :
-- il n'y en a pas d'autre ici.
--
-- 🔴 BLOQUANTE : le balayage ecrit cette table des le deploiement, et surtout la purge a 90 jours ne doit
-- JAMAIS tourner avant que le premier balayage ait ecrit l'historique. L'ordre est rendu mecanique dans le
-- worker (le balayage est attendu AVANT la purge au demarrage), mais la migration doit passer AVANT le
-- deploiement, image construite d'abord. Elle n'est PAS appliquee au moment ou ce fichier est ecrit : le
-- DATABASE_URL du poste de travail pointe sur la PRODUCTION.

create table if not exists analyse_jour (
  tenant_id           uuid not null references tenants(id) on delete cascade,
  -- Le jour, dans le fuseau de l'espace au moment du calcul. Une `date` et pas un `timestamptz` : c'est un
  -- jour civil, pas un instant, et le stocker en instant inviterait a le reconvertir dans un autre fuseau.
  jour                date not null,
  conversations       integer not null,
  -- Combien de ces analyses portent LES DEUX notes. Denominateur des deux moyennes ; jamais `conversations`.
  mesurees            integer not null,
  -- Sommes sur les seules analyses mesurees. Nulles quand `mesurees = 0`, et c'est distinct de zero.
  somme_satisfaction  numeric(8,2),
  somme_urgence       numeric(8,2),
  -- La repartition par intention, en jsonb : l'enumeration est FERMEE (six valeurs) mais elle a deja
  -- change une fois, et six colonnes obligeraient a une migration a chaque evolution. Un objet se lit
  -- entierement et ne perd pas de membre en chemin.
  intentions          jsonb not null default '{}'::jsonb,
  calcule_le          timestamptz not null default now(),
  primary key (tenant_id, jour)
);

-- Les deux sommes n'ont de sens qu'avec des mesures, et un compte negatif n'existe pas. Le CHECK dit les
-- deux, et il attrape un balayage qui ecrirait une somme sans son denominateur.
alter table analyse_jour drop constraint if exists analyse_jour_mesures_chk;
alter table analyse_jour add constraint analyse_jour_mesures_chk
  check (
    conversations >= 0
    and mesurees >= 0
    and mesurees <= conversations
    and (mesurees > 0 or (somme_satisfaction is null and somme_urgence is null))
  );

-- ---------------------------------------------------------------------------------------------------
-- LA RETENTION DES CONVERSATIONS, REGLABLE PAR ESPACE.
--
-- 🔴 LE RESPONSABLE DE TRAITEMENT EST LE CLIENT, PAS NOUS, et c'est la seule raison de cette colonne. Le
-- RGPD ne fixe aucune duree (article 5.1.e : « pas plus longtemps que necessaire ») ; c'est donc au client
-- de trancher pour ses donnees, et un chiffre unique impose a tout le monde ferait de nous le decideur d'une
-- chose qui ne nous appartient pas. La valeur d'instance (`CONVERSATION_RETENTION_DAYS`, 90 depuis le
-- 2026-09-17) reste le DEFAUT de qui n'a rien regle.
--
-- ⚠️ NULLABLE, ET `null` EST LE CAS NORMAL : aucun espace n'en porte, et ils retombent tous sur le defaut
-- de l'instance. Une valeur par defaut en base aurait FIGE le chiffre du jour de la migration, et changer
-- la variable d'environnement n'aurait plus rien fait, en silence.
--
-- 🔴 CETTE COLONNE EST DEVENUE BLOQUANTE POUR UN SECOND CHEMIN, LE 2026-09-17 : `getSummary` la LIT, dans
-- une sous-requete, pour annoncer a l'ecran la duree reellement appliquee a CET espace. C'est le chemin
-- d'affichage de toute la page Synthese. Deployer le code avant cette migration ne casserait donc pas
-- seulement le balayage, ca rendrait `42703` sur la page entiere, en boucle. Meme symptome que le
-- 2026-08-17, meme parade : la migration passe AVANT, image construite d'abord.
--
-- ⚠️ `0` DESACTIVE LA PURGE POUR CET ESPACE, comme la variable d'instance, et c'est ce qui rend le CHECK
-- utile : il refuse le negatif, qui n'a aucun sens, et borne a 3650 jours, au-dela desquels le chiffre est
-- une faute de frappe plutot qu'une politique.
alter table tenant_settings add column if not exists conversation_retention_days integer;

alter table tenant_settings drop constraint if exists tenant_settings_retention_chk;
alter table tenant_settings add constraint tenant_settings_retention_chk
  check (conversation_retention_days is null or (conversation_retention_days >= 0 and conversation_retention_days <= 3650));
