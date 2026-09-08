-- 0117_mot_cle_sans_ponctuation_finale.sql : reparer les boutons de chaine dont la phrase finit par une
-- ponctuation.
--
-- 🔴 LE DEFAUT, VECU LE 2026-09-08. Julien publie un post dont le bouton porte la phrase
-- « je veux mon de code promo! ». Il appuie, WhatsApp s'ouvre, le message part... et AUCUN scenario ne
-- demarre. Le message REÇU est « je veux mon de code promo », sans le point d'exclamation.
--
-- La cause est dans l'adresse. `encodeURIComponent` laisse `!`, `'`, `(`, `)` et `*` tels quels (ce sont des
-- sous-delimiteurs licites), donc l'URL finissait par `...promo!`. L'auto-detection de liens de WhatsApp
-- traite une ponctuation finale comme la ponctuation de la PHRASE et non comme une partie du lien : elle
-- l'exclut de ce qui est ouvert. Le caractere ne partait donc jamais. Et la correspondance etant en mode
-- `contains`, un message plus COURT que le mot-cle ne correspond a RIEN.
--
-- 🔴 POURQUOI UNE MIGRATION, ET PAS SEULEMENT LE CORRECTIF DE CODE. Le code corrige les adresses A VENIR
-- (`encodeTexteWaMe`). Mais les posts DEJA PUBLIES portent l'ancienne adresse et ne sont plus modifiables :
-- ils enverront toujours le message ampute. Seul le MOT-CLE peut les rattraper, et il vit en base.
--
-- Ce que ca donne, et les deux formes correspondent alors :
--   phrase (inchangee) : « je veux mon de code promo! »   ce que le client a ecrit, et ce que l'abonne verra
--   mot-cle (ici)      : « je veux mon de code promo »    ce qui declenche, en mode `contains`
--
-- ⚠️ Seule la ponctuation de FIN part. Celle du milieu est du texte (« -20%, c'est maintenant ») et la
-- retirer changerait le sens de la correspondance.
--
-- 🔴 LA CLASSE S'ECRIT AUTREMENT ICI QUE EN JAVASCRIPT, ET LA PREMIERE VERSION DE CE FICHIER NE RETIRAIT
-- RIEN DU TOUT. Dans une classe POSIX, le backslash n'est PAS un echappement (il vaut lui-meme) et `]`
-- FERME la classe : `[!.,;:?)\]"'*»]` etait donc lu comme la classe `[!.,;:?)\]` suivie du texte litteral
-- `"'*»]+$`, qui ne correspond a rien. Le crochet fermant doit etre le PREMIER caractere de la classe pour
-- valoir lui-meme. Verifie contre la base avant ecriture, sur les phrases reelles.
--
-- ⚠️ Bornee aux automations REELLEMENT possedees par un lien de chaine, jamais aux automations ordinaires du
-- client, dont les mots-cles lui appartiennent. Meme garde miroir que la 0116.
--
-- IDEMPOTENTE : rejouee, elle reecrit la meme valeur (retirer la ponctuation finale d'un texte qui n'en a
-- plus ne change rien). Le `where` final evite d'ecrire pour ne rien changer.

update automations a
   set trigger_config = jsonb_set(
         a.trigger_config,
         '{keywords}',
         to_jsonb(array[btrim(regexp_replace(btrim(l.phrase), '[]!.,;:?)"''*»]+$', ''))])
       )
  from channelsme_links l
 where l.automation_id = a.id
   and l.tenant_id = a.tenant_id
   and a.possede_par = 'channelsme_link'
   and btrim(regexp_replace(btrim(l.phrase), '[]!.,;:?)"''*»]+$', '')) <> ''
   and a.trigger_config->'keywords' IS DISTINCT FROM
       to_jsonb(array[btrim(regexp_replace(btrim(l.phrase), '[]!.,;:?)"''*»]+$', ''))]);
