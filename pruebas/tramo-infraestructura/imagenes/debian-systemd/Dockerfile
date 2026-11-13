FROM debian:trixie
ENV container=docker DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get -y upgrade \
 && apt-get install -y --no-install-recommends systemd systemd-sysv dbus python3 python3-apt ca-certificates curl git openssh-server podman sudo iproute2 procps \
 && rm -f /usr/sbin/policy-rc.d \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*
STOPSIGNAL SIGRTMIN+3
CMD ["/bin/sh", "-c", "mount -o remount,rw /sys/fs/cgroup && exec /lib/systemd/systemd"]
