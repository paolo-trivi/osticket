# Immagine del pannello classico osTicket (codice di legacy/) per lo stack TailTicket.
# Contesto di build: la root del repository (vedi Dockerfile.dockerignore accanto a questo file).
#   docker build -f deploy/osticket/Dockerfile -t tailticket-legacy .
# Ruoli (primo argomento): "web" (Apache, default) oppure "cron" (php api/cron.php a intervalli).
# Immagine base: in CI si usa un mirror di Docker Hub (--build-arg PHP_IMAGE=mirror.gcr.io/library/php:8.3-apache)
ARG PHP_IMAGE=php:8.3-apache
FROM ${PHP_IMAGE}

# APCu (cache usata da osTicket): sorgente PECL scaricato con curl, che rispetta HTTPS_PROXY
ARG APCU_VERSION=5.1.24

# CA aggiuntiva opzionale per build dietro proxy TLS (secret "build_ca"): non resta nell'immagine
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then cp /run/secrets/build_ca /usr/local/share/ca-certificates/build-ca.crt && update-ca-certificates; fi; \
    sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \
    apt-get update \
 && apt-get install -y --no-install-recommends \
      libpng-dev libjpeg62-turbo-dev libfreetype6-dev libicu-dev libzip-dev libxml2-dev msmtp-mta mariadb-client \
 && docker-php-ext-configure gd --with-freetype --with-jpeg \
 && docker-php-ext-install -j"$(nproc)" mysqli gd intl zip \
 && docker-php-source extract \
 && mkdir -p /usr/src/php/ext/apcu \
 && curl -fsSL --retry 5 --retry-all-errors "https://pecl.php.net/get/apcu-${APCU_VERSION}.tgz" | tar xz --strip-components=1 -C /usr/src/php/ext/apcu \
 && docker-php-ext-install -j"$(nproc)" apcu \
 && docker-php-source delete \
 && a2enmod rewrite remoteip headers \
 && rm -f /usr/local/share/ca-certificates/build-ca.crt && update-ca-certificates \
 && rm -rf /var/lib/apt/lists/* /tmp/pear

COPY deploy/osticket/php.ini /usr/local/etc/php/conf.d/zz-tailticket.ini
COPY deploy/osticket/apache.conf /etc/apache2/conf-enabled/zz-tailticket.conf

# Codice osTicket in /classic; setup/ resta fuori dalla docroot e viene copiato solo per l'installazione
COPY --chown=root:www-data legacy/ /var/www/html/classic/
RUN mv /var/www/html/classic/setup /usr/local/share/osticket-setup \
 && rm -f /var/www/html/classic/include/ost-config.php \
 && mkdir -p /var/lib/osticket /var/www/html/classic/include/plugins \
 && chown -R www-data:www-data /var/lib/osticket /var/www/html/classic/include/plugins \
 && printf '<?php header("Location: classic/"); ' > /var/www/html/index.php

COPY deploy/osticket/entrypoint.sh deploy/osticket/gen-config.php deploy/osticket/install.php deploy/osticket/db-state.php /usr/local/lib/tailticket/
RUN chmod 0755 /usr/local/lib/tailticket/entrypoint.sh

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=5 \
  CMD [ "sh", "-c", "test \"${TAILTICKET_ROLE:-web}\" = cron && test -f /tmp/cron.ok || curl -fsS -o /dev/null http://127.0.0.1/classic/scp/login.php" ]

ENTRYPOINT ["/usr/local/lib/tailticket/entrypoint.sh"]
CMD ["web"]
