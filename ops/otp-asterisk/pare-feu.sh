#!/bin/sh
# LE PARE-FEU DE L'ASTERISK DU PONT DU CODE (lot 3a). Le SIP (5080) et le son (20000-20100, rtp.conf) n'acceptent que
# les plages de DIDWW ; tout autre paquet vers ces ports est jete. Rien d'autre n'est touche : pas de politique par
# defaut, ni le 22, ni le 80 ou le 443 (docker-proxy).
# Plages mesurees le 2026-10-05 pendant un vrai appel : signalisation de 185.238.173.49, son de 46.19.210.39 ; et un
# scanneur, 179.43.134.194, envoyait deja des INVITE au 5080 (rejetes par identify_by = ip, ce pare-feu est le second
# verrou).
# Relancable : une regle deja posee n'est pas reposee. Les regles iptables ne survivent pas a un redemarrage du VPS :
# ce script est lance au demarrage par la crontab de root (@reboot), voir README.md.
set -e
# La crontab ne cherche que dans /usr/bin et /bin, et iptables vit dans /usr/sbin.
PATH=/usr/sbin:/sbin:/usr/bin:/bin
for port in 5080 20000:20100; do
  for plage in 185.238.172.0/22 46.19.208.0/21; do
    iptables -C INPUT -p udp --dport "$port" -s "$plage" -j ACCEPT 2>/dev/null ||
      iptables -A INPUT -p udp --dport "$port" -s "$plage" -j ACCEPT
  done
  iptables -C INPUT -p udp --dport "$port" -j DROP 2>/dev/null ||
    iptables -A INPUT -p udp --dport "$port" -j DROP
done
iptables -S INPUT
