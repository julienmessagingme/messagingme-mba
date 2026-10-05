-- 0210 : la reserve de numeros fournis et les codes de verification captes (lot 3a, spec
-- docs/superpowers/specs/2026-10-05-pont-du-code-design.md). Engage Me fournit un numero WhatsApp a un client qui n'en
-- a pas ; Meta verifie ce numero en l'appelant, et c'est notre Asterisk qui decroche, puis l'API qui lit le code.
--
--  - numeros_fournis : la reserve. Un numero achete par Julien chez DIDWW, branche sur le trunk de l'Asterisk par le
--    serveur et declare dans /ops. numero en chiffres seuls (le format wa_id), unique ; didww_did_id unique (le meme
--    numero DIDWW ne se declare pas deux fois sous deux ecritures). Le statut est une liste fermee.
--  - numeros_fournis_espace_chk : A SENS UNIQUE. Un espace n'est nomme que sur un numero attribue ; l'inverse est un
--    etat atteignable (l'espace supprime, sa cle etrangere en set null), et le refuser ferait echouer la suppression
--    d'un espace sur une contrainte de la reserve.
--  - codes_verification : un appel recu sur un numero de la reserve, son code (nul = aucun code certain, la regle
--    unanimite ou rien) et sa transcription, gardee pour le depannage. appel_id (l'identifiant d'appel d'Asterisk)
--    unique : un envoi rejoue par le script n'ecrit pas deux lignes. Cascade depuis le numero.
--
-- 🔴 ELLE AJOUTE DEUX TABLES QUE L'ANCIEN CODE IGNORE, DONC AVANT LE UP de l'API et des deux workers : la route du
-- pont et le balayage de retention les nomment.
--
-- ⚠️ AUCUN VERROU A CRAINDRE : deux tables neuves, et la seule table existante nommee (tenants) ne l'est que par une
-- cle etrangere, qui pose un SHARE ROW EXCLUSIVE bref. lock_timeout par prudence.
set local lock_timeout = '5s';

create table if not exists numeros_fournis (
  id            uuid primary key default gen_random_uuid(),
  numero        text not null,
  didww_did_id  text not null,
  statut        text not null default 'libre',
  tenant_id     uuid references tenants (id) on delete set null,
  attribue_le   timestamptz,
  cree_le       timestamptz not null default now(),
  constraint numeros_fournis_numero_key unique (numero),
  constraint numeros_fournis_didww_key unique (didww_did_id),
  constraint numeros_fournis_numero_chk check (numero ~ '^[1-9][0-9]{6,14}$'),
  constraint numeros_fournis_statut_chk check (statut in ('libre', 'attribue', 'resilie')),
  constraint numeros_fournis_espace_chk check (tenant_id is null or statut = 'attribue')
);

create table if not exists codes_verification (
  id             uuid primary key default gen_random_uuid(),
  numero_id      uuid not null references numeros_fournis (id) on delete cascade,
  appel_id       text not null,
  recu_le        timestamptz not null default now(),
  code           text,
  transcription  text not null default '',
  cause          text,
  constraint codes_verification_appel_key unique (appel_id),
  constraint codes_verification_code_chk check (code is null or code ~ '^[0-9]{6}$'),
  -- Un code certain n'a pas de cause d'echec, et un appel sans code en a toujours une.
  constraint codes_verification_cause_chk check (
    (code is not null and cause is null)
    or (code is null and cause in ('transcription_indisponible', 'code_introuvable'))
  )
);

-- La lecture de /ops (le dernier code par numero) et celle du lot 3b (le code recu sur ce numero depuis telle heure).
create index if not exists codes_verification_numero_idx on codes_verification (numero_id, recu_le desc);
