# No build step and no dependencies — see server.mjs for why. One file, one
# base image, matching the main Dockerfile's choice of Debian slim over
# Alpine for consistency rather than any native-binary need this has.
FROM node:22-slim
WORKDIR /app
COPY server.mjs ./
CMD ["node", "server.mjs"]
