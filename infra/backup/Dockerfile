# Backup job image (architecture.md §8.8).
#
# Separate from the web image on purpose. pg_dump and pg_restore pull in ~30MB
# of PostgreSQL client, and the web service is scale-to-zero — it would pay that
# on every cold start for a tool it never runs.
FROM node:22-slim

# postgresql-client from PGDG rather than Debian's, which ships an older major.
# pg_dump refuses to dump a server newer than itself, so the client has to lead
# the server, not trail it. Pinned to a major rather than "latest" so an upgrade
# is a deliberate edit here.
ARG PG_MAJOR=17
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
       -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends "postgresql-client-${PG_MAJOR}" \
  && apt-get purge -y curl gnupg \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Paths are relative to infra/backup, which is this image's whole build context
# — three files rather than the repository. That keeps the upload small and,
# more usefully, means this build does not depend on the root .dockerignore,
# which excludes `infra` for the web image's benefit and would otherwise leave
# these COPY lines with nothing to copy.
#
# Only the S3 client. The backup job shares no code with the application — it
# talks to Postgres and to R2 and nothing else — so pulling in the app's
# dependency tree would be weight with no purpose.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY backup.mjs verify-restore.mjs ./

# Runs as a Cloud Run Job, so it exits when it is done rather than serving.
USER node
ENTRYPOINT ["node", "backup.mjs"]
