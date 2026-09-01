-- 0102_porte_debit_numero.sql : le budget d'envoi d'un numéro, PARTAGÉ entre les process.
--
-- Constat du contre-audit du 2026-09-01, revérifié dans le code : `src/index.ts` et `src/worker.ts`
-- construisaient CHACUN leur arbitre de débit en mémoire. L'API et le worker sont deux conteneurs, donc un
-- numéro avait déjà deux budgets en production : pendant qu'une campagne part du worker, un opérateur qui
-- répond depuis l'inbox consomme un second budget sur le même numéro. Le débit affiché n'était pas une
-- propriété du numéro, c'était une propriété par process.
--
-- ⚠️ Ce n'est PAS un sujet de gros volume : ça se produit avec un client et deux messages.
--
-- Une ligne par numéro, et une seule colonne qui compte : l'instant à partir duquel le prochain envoi est
-- autorisé. C'est exactement l'état que le limiteur en mémoire tenait dans un champ (`nextAllowed`), sorti
-- du process pour être partagé. La réservation se fait en UNE instruction atomique (`insert ... on conflict
-- do update`), donc deux process qui réservent en même temps se sérialisent sur le verrou de ligne, ce qui
-- est précisément le comportement voulu.
--
-- 🔴 AUCUNE transaction n'est tenue ouverte pendant l'appel à Meta. La réservation est une instruction, elle
-- rend le temps d'attente, et l'attente se fait EN DEHORS de la base. Tenir un verrou pendant un appel
-- réseau chez un tiers serait la faute classique de ce genre de brique.
--
-- Le temps de référence est celui de POSTGRES, pas celui des conteneurs : deux horloges qui dérivent de
-- quelques secondes suffiraient à laisser passer une rafale, et personne ne surveille l'heure d'un conteneur.
--
-- BLOQUANTE : dès le déploiement, chaque envoi Meta réserve son créneau ici.

create table if not exists phone_rate_gate (
  phone_number_id  text primary key,
  -- Instant du prochain envoi autorisé. Peut être dans le passé (numéro inactif) : c'est alors « tout de
  -- suite », et la réservation repart de `now()`.
  next_allowed_at  timestamptz not null,
  updated_at       timestamptz not null default now()
);
