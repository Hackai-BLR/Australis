FROM debian:trixie
ENV container=docker DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv dbus python3 ca-certificates openssh-server podman iproute2 procps \
 && apt-get purge -y sudo git curl sqlite3 || true \
 && rm -f /usr/sbin/policy-rc.d \
 && mkdir -p /run/sshd /root/.ssh && chmod 700 /root/.ssh \
 && systemctl enable ssh \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*
STOPSIGNAL SIGRTMIN+3
CMD ["/bin/sh", "-c", "mount -o remount,rw /sys/fs/cgroup && exec /lib/systemd/systemd"]
