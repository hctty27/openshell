FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server lrzsz \
    && useradd -m -s /bin/bash -p 'NP' zmodemlab \
    && rm -f /etc/ssh/ssh_host_* \
    && rm -rf /var/lib/apt/lists/*

COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /usr/local/bin/openshell-zmodem-lab.sh

# Windows checkouts may contain CRLF; normalize before invoking /bin/sh.
RUN sed -i 's/\r$//' /usr/local/bin/openshell-zmodem-lab.sh \
    && chmod 0755 /usr/local/bin/openshell-zmodem-lab.sh

EXPOSE 22

HEALTHCHECK --interval=2s --timeout=3s --start-period=2s --retries=20 \
    CMD bash -c "exec 3<>/dev/tcp/127.0.0.1/22"

ENTRYPOINT ["/bin/sh", "/usr/local/bin/openshell-zmodem-lab.sh"]
