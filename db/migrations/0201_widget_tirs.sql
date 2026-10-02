-- 0201 : les tirs des widgets, le pendant d'`automation_fires` (lot 3 de
-- docs/superpowers/plans/2026-10-02-widget-whatsapp.md, décisions de Julien du 2026-10-02).
--
-- Un widget dont le devenir est 'scenario' démarre son scénario DANS le chemin de réception, par le runner des
-- automations (`runAutomations`), auquel on passe en mémoire l'automation équivalente au widget : mot-clé = sa
-- phrase en `contains`, son scénario, `maxFiresPerHour` = `max_par_heure`. Il n'y a PAS d'automation compagnon en
-- base (décision de Julien) : c'est ce qui rend cette table INÉVITABLE.
--
-- 🔴 POURQUOI PAS `automation_fires`. Les gardes du runner (anti-rebond par contact, plafond horaire par
-- automation, annulation du tir quand le scénario ne part pas) lisent et écrivent des tirs par (identifiant,
-- contact). `automation_fires.automation_id` référence `automations(id)` : l'identifiant d'un widget y violerait
-- la clé étrangère, et le premier tir lèverait. Sans tirs gardés, l'anti-rebond et le plafond ne tiendraient pas,
-- et une phrase PUBLIQUE envoyée en rafale ferait partir autant de scénarios facturés. Recopier ces gardes à côté
-- du runner est exactement ce que la décision interdit.
--
-- La forme est celle d'`automation_fires` (0052), à deux écarts près :
--  - `tenant_id`, que `automation_fires` n'a pas : chaque requête du store filtre `tenant_id = $1` (la RLS est
--    contournée par le pooler, ce filtre est le seul contrôle), et la purge RGPD efface par espace sans jointure ;
--  - pas de `fired_for` (0075) : ce marqueur ne sert qu'au déclencheur `avant_date`, qu'un widget n'est jamais.
--
-- ⚠️ ELLE PORTE UN NUMÉRO (`wa_id`), DONC ELLE ENTRE DANS LA PURGE RGPD (`PgContactStore.purgeMany`), à côté
-- d'`automation_fires`. 🔴 Et c'est ce qui la rend BLOQUANTE : le code qui la nomme dans la transaction de purge,
-- déployé avant elle, ferait échouer TOUTE suppression de contact en `42P01` (la leçon de 0163). Elle passe donc
-- AVANT le `up`, comme 0200, dont elle dépend.
--
-- TRANSACTIONNELLE : une table neuve et vide ne bloque l'écriture de personne. ADDITIVE : l'ancien code l'ignore.
create table if not exists widget_tirs (
  -- `on delete cascade` : un widget supprimé n'a plus de tirs à garder, et sa balise rend un script inerte.
  widget_id  uuid not null references widgets(id) on delete cascade,
  tenant_id  uuid not null references tenants(id) on delete cascade,
  -- Le `wa_id` tel que Meta l'envoie (chiffres nus, ou BSUID), comme `automation_fires.wa_id` : c'est la clé que
  -- le runner passe.
  wa_id      text not null,
  tire_le    timestamptz not null default now(),
  -- Une ligne par couple (widget, contact), écrasée à chaque tir : l'anti-rebond lit la dernière. Elle sert aussi
  -- le plafond horaire (« les tirs de CE widget depuis une heure »), par son préfixe `widget_id`, comme la clé
  -- primaire d'`automation_fires` sert `firedSince`.
  primary key (widget_id, wa_id)
);
