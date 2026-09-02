-- 0109_pool_attentes.sql : l'attente d'une connexion, agregee par minute et par process.
--
-- Lot 7 du plan post-audit, question de Julien : « les 16 connexions, on fait quoi ? on serre les fesses, on
-- prend une marge, on autoscale, on met des alertes ? »
--
-- Le calcul a tranche : le pool n'est PAS ce qui cassera a 25 clients (quelques dizaines de requetes/s pour
-- une capacite d'environ 700 par process). Le vrai defaut est l'AVEUGLEMENT : `/ops` n'expose rien du pool,
-- donc une saturation s'apprendrait par un client qui appelle.
--
-- 🔴 POURQUOI UNE TABLE, alors qu'un compteur en memoire suffirait a afficher l'instant. Deux raisons, et la
-- seconde est decisive :
--   1. une jauge lue au moment ou l'on ouvre l'ecran affiche zero presque toujours et RATE le pic, qui est
--      justement ce qu'on cherche (objection de Julien, et elle est juste) ;
--   2. `/ops` est servi par l'API : elle voit son propre pool en memoire, JAMAIS celui du worker. Cette table
--      est le SEUL canal par lequel le worker peut se montrer. Sans elle, la moitie de la mesure est invisible.
--
-- Volume : une ligne par minute et par process, soit ~2880 lignes par jour pour les deux. Purgee par le
-- balayage de retention general (`POOL_ATTENTES_RETENTION_DAYS`, 7 jours par defaut).
--
-- ⚠️ NON BLOQUANTE : l'ecriture est best-effort et la lecture rend une liste vide si la table manque. Sans la
-- migration, l'ecran perd sa courbe et garde son etat instantane. Une mesure ne doit jamais faire tomber ce
-- qu'elle mesure.

create table if not exists pool_attentes (
  -- « api » ou « worker ». Deux pools distincts, deux lignes par minute : les agreger perdrait justement
  -- l'information qui sert a savoir lequel des deux souffre.
  process text not null,
  -- Debut de la minute (tronquee). C'est la cle avec le process.
  minute timestamptz not null,
  -- Acquisitions mesurees dans la minute, toutes durees confondues.
  echantillons integer not null default 0,
  -- Parmi elles, celles demandees alors que le pool etait SATURE. C'est le signal ; le reste n'est que
  -- l'ouverture normale d'une connexion neuve (TCP + TLS), qui coute quelques millisecondes et n'a rien
  -- d'anormal, surtout au demarrage.
  attentes integer not null default 0,
  -- La plus longue acquisition de la minute. AUCUN pic n'est perdu : on stocke un maximum de mesures
  -- exactes, pas un echantillon.
  max_ms integer not null default 0,
  -- Somme des durees, pour une moyenne lisible sans garder les echantillons.
  somme_ms bigint not null default 0,
  primary key (process, minute)
);

-- La lecture est toujours « les N dernieres minutes, tous process » : c'est exactement cet index.
create index if not exists pool_attentes_minute_idx on pool_attentes (minute desc);
