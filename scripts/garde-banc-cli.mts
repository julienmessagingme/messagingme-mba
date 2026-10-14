/**
 * La garde des bancs en ligne de commande (`scripts/garde-banc.ts`), sur `DATABASE_URL`. `banc-api.sh` l'appelle AVANT
 * que les migrations, le worker ou l'API du banc ne touchent la base : le banc la rejoue lui-même (`banc-api.mts`), mais
 * trop tard pour eux, et un worker du banc branché sur la production y consommerait de vraies tâches. Sort en erreur
 * si la base ne se déclare pas jetable.
 */
import { exigerBaseJetable } from './garde-banc';

exigerBaseJetable(process.env.DATABASE_URL ?? '');
console.log('garde des bancs : base jetable acceptée');
