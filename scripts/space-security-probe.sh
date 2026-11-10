#!/bin/sh
# Security Copilot read-only probe (scripts/space-security-inventory.mjs runs it on each host; "refresh" also refreshes the package lists).
LC_ALL=C; export LC_ALL
SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo -n"
if [ "$1" = refresh ]; then
  command -v apt-get >/dev/null 2>&1 && $SUDO apt-get update -qq >/dev/null 2>&1
  command -v dnf >/dev/null 2>&1 && $SUDO dnf -q makecache >/dev/null 2>&1
fi
echo "## os"
. /etc/os-release 2>/dev/null && echo "id=$ID"; . /etc/os-release 2>/dev/null && echo "version=$VERSION_ID"
echo "kernel=$(uname -r)"
command -v pveversion >/dev/null 2>&1 && echo "pve=$(pveversion | sed -n 's#^pve-manager/\([0-9.]*\).*#\1#p')"
echo "## dpkg"
command -v dpkg-query >/dev/null 2>&1 && dpkg-query -W -f='${db:Status-Abbrev}\t${Package}\t${Version}\t${source:Package}\t${source:Version}\n' 2>/dev/null | awk -F'\t' '$1 ~ /^ii/ {print $2"\t"$3"\t"$4"\t"$5}'
echo "## rpm"
command -v rpm >/dev/null 2>&1 && rpm -qa --qf '%{NAME}\t%{EPOCHNUM}:%{VERSION}-%{RELEASE}\t%{SOURCERPM}\n' 2>/dev/null
echo "## opkg"
command -v opkg >/dev/null 2>&1 && opkg list-installed 2>/dev/null
echo "## apt-security"
command -v apt >/dev/null 2>&1 && apt list --upgradable 2>/dev/null | grep -- '-security'
echo "## dnf-security"
command -v dnf >/dev/null 2>&1 && dnf -C -q updateinfo list --security 2>/dev/null
echo "## dnf-cves"
command -v dnf >/dev/null 2>&1 && dnf -C -q updateinfo list --security --with-cve 2>/dev/null
# A Debian/Ubuntu security build keeps the upstream version and backports fixes: its distro metadata, not NVD, is the truth.
distro_build() {
  command -v dpkg >/dev/null 2>&1 || return 1
  o=$(dpkg -S "$1" 2>/dev/null | head -1 | cut -d: -f1)
  [ -n "$o" ] && dpkg-query -W -f='${Version}' "$o" 2>/dev/null | grep -qE '[+~]deb[0-9]+u[0-9]+|ubuntu0\.[0-9]+\.[0-9]+\.[0-9]+'
}
echo "## php"
seen=""
for p in /opt/plesk/php/*/bin/php /usr/bin/php /usr/bin/php[0-9]* /usr/local/bin/php; do
  [ -x "$p" ] || continue; r=$(readlink -f "$p"); case " $seen " in *" $r "*) continue;; esac; seen="$seen $r"
  distro_build "$r" || echo "$p $("$p" -r 'echo PHP_VERSION;' 2>/dev/null)"
done
echo "## node"
for n in /usr/bin/node /usr/local/bin/node; do [ -x "$n" ] && ! distro_build "$(readlink -f "$n")" && echo "$n $("$n" -v 2>/dev/null)"; done
# Node binaries running processes execute (bundled runtimes); official builds name their version in the headers URL, so none is executed.
a=$(readlink -f /usr/bin/node 2>/dev/null); b=$(readlink -f /usr/local/bin/node 2>/dev/null)
for e in /proc/[0-9]*/exe; do readlink "$e"; done 2>/dev/null | grep '/node$' | sort -u | while read -r n; do
  [ "$n" = "$a" ] || [ "$n" = "$b" ] || echo "$n $(LC_ALL=C grep -a -o -m1 -E 'release/v[0-9]+\.[0-9]+\.[0-9]+/node-v' "$n" 2>/dev/null | head -1 | cut -d/ -f2)"
done
echo "## chrome"
command -v google-chrome >/dev/null 2>&1 && google-chrome --version 2>/dev/null
echo "## listening"
ss -tlnH 2>/dev/null | awk '{print $4}'
echo "## docker"
if command -v docker >/dev/null 2>&1 && ids=$($SUDO docker ps -q 2>/dev/null); then
  echo listed
  [ -n "$ids" ] && $SUDO docker inspect --format '{{.Config.Image}} {{.Image}}' $ids 2>/dev/null | sort -u
fi
echo "## reboot"
if [ -f /var/run/reboot-required ]; then echo yes; elif command -v needs-restarting >/dev/null 2>&1; then needs-restarting -r >/dev/null 2>&1 || echo yes; fi
echo "## end"
