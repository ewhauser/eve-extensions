FROM public.ecr.aws/lambda/microvms:al2023-minimal@sha256:1cc40991f5cab3fc8d2dd16350354d5780ea9e878fcf9f46904dddd63a7b983b

RUN dnf install -y acl attr e2fsprogs findutils gzip iproute procps-ng python3 shadow-utils tar \
      util-linux which zstd && \
    dnf clean all && \
    mkdir -p /opt/eve/lower /opt/eve/state /opt/eve/controller && \
    tar --acls --xattrs --xattrs-include='*' --numeric-owner --one-file-system \
      --exclude=./opt/eve --exclude=./proc --exclude=./sys --exclude=./dev --exclude=./run \
      -C / -cf - . | tar --acls --xattrs --xattrs-include='*' --numeric-owner -C /opt/eve/lower -xf - && \
    mkdir -p /opt/eve/lower/dev /opt/eve/lower/proc /opt/eve/lower/run \
      /opt/eve/lower/sys /opt/eve/lower/tmp /opt/eve/lower/workspace && \
    chmod 1777 /opt/eve/lower/tmp

COPY controller.py /opt/eve/controller/controller.py
COPY launcher.py /opt/eve/controller/launcher.py
COPY start.sh /opt/eve/controller/start.sh
RUN chmod 0755 /opt/eve/controller/start.sh /opt/eve/controller/controller.py \
      /opt/eve/controller/launcher.py

EXPOSE 8080 9000
ENTRYPOINT ["/opt/eve/controller/start.sh"]
