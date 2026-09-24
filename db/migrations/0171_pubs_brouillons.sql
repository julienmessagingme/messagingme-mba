-- Brouillons de publicites Click-to-WhatsApp.
--
-- PUREMENT ADDITIVE : une seule table neuve, aucune colonne existante touchee. L'ancien code ignore une
-- table qu'il ne nomme pas, donc elle passe AVANT le deploiement.
--
-- POURQUOI UNE TABLE A PART, ET PAS UN ETAT DE PLUS SUR publicites. La colonne campagne_id de publicites
-- est not null et porte l'unique (tenant_id, campagne_id) : c'est par elle que le routage retrouve la
-- publicite d'un lead qui vient de cliquer, sur le chemin chaud. Un brouillon n'a aucune campagne chez
-- Meta. La rendre nullable ferait entrer dans cette table des lignes sans identite, et l'unique cesserait
-- de contraindre quoi que ce soit pour elles, Postgres considerant les null comme distincts.
--
-- Un brouillon n'est donc pas une publicite degradee, c'est un FORMULAIRE memorise : ni identifiant Meta,
-- ni depense, ni entonnoir, ni automation.

begin;

create table if not exists pubs_brouillons (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,

  -- LE FORMULAIRE TEL QU'IL A ETE TAPE, ET C'EST DELIBERE.
  -- Ces champs sont du TEXTE, y compris le budget et les dates, alors que publicites les porte en
  -- numeric et timestamptz. Un brouillon sert justement a garder un travail INCOMPLET : exiger une date
  -- valide ou un nombre pour enregistrer refuserait la moitie des brouillons qu'on veut pouvoir poser.
  -- La validation reste au seul endroit ou elle protege quelque chose, la creation reelle chez Meta.
  nom                text not null default '',
  titre              text not null default '',
  texte              text not null default '',
  accueil            text not null default '',
  message_prerempli  text not null default '',
  budget_total       text not null default '',
  debut              text not null default '',
  fin                text not null default '',
  pays               text not null default '',
  age_min            text not null default '',
  age_max            text not null default '',
  tag_qualification  text not null default '',

  -- QUI REPONDRA AUX LEADS. Enumeration fermee, donc un CHECK : elle vient d'une liste deroulante, pas
  -- d'une saisie libre, et une troisieme valeur serait un bug et non un brouillon incomplet.
  destination        text not null default 'scenario',

  -- Le scenario vise. Vraie cle etrangere, en on delete set null et JAMAIS cascade : supprimer un
  -- scenario ne doit pas faire disparaitre le brouillon qui le citait, il doit juste lui faire oublier
  -- ce choix-la. Nul quand rien n'est encore choisi.
  workflow_id        uuid references workflows(id) on delete set null,

  -- LE VISUEL EST GARDE, decision de Julien du 2026-09-24. Un brouillon qui perd l'image n'est pas un
  -- brouillon : on le rouvre et il manque precisement ce qu'on a mis le plus de temps a choisir.
  -- La LISTE ne selectionne JAMAIS visuel_octets : une colonne de plusieurs megaoctets dans la requete
  -- de l'ecran d'accueil transformerait son ouverture en transfert de dizaines de megaoctets. Seule la
  -- lecture d'UN brouillon la lit. C'est un contrat avec une requete precise, comme un index partiel.
  visuel_octets      bytea,
  visuel_type        text,

  cree_le            timestamptz not null default now(),
  modifie_le         timestamptz not null default now(),

  constraint pubs_brouillons_destination_chk
    check (destination in ('scenario', 'agent_meta')),

  -- Les deux champs du visuel vont ENSEMBLE ou pas du tout : un type sans octets afficherait une image
  -- vide, des octets sans type ne pourraient pas etre rendus en data-url.
  constraint pubs_brouillons_visuel_chk
    check ((visuel_octets is null and visuel_type is null)
        or (visuel_octets is not null and visuel_type in ('image/jpeg', 'image/png')))
);

-- La liste d'un espace, du plus recemment modifie au plus ancien : c'est l'ordre dans lequel l'ecran
-- les montre, et le seul acces qui existe sur cette table.
create index if not exists pubs_brouillons_espace_idx
  on pubs_brouillons (tenant_id, modifie_le desc);

-- AUCUNE CONTRAINTE D'UNICITE SUR LE NOM, deliberement : deux brouillons peuvent porter le meme nom, ou
-- aucun. Un brouillon sert a ne pas perdre un travail en cours, pas a etre bien range.

commit;
