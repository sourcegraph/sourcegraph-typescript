FROM node:13.14.0-alpine@sha256:4d6b35f8d14b2f476005883f9dec0a93c83213838fd3def3db0d130b1b148653

# Use tini (https://github.com/krallin/tini) for proper signal handling.
RUN apk add --no-cache tini
ENTRYPOINT ["/sbin/tini", "--"]

# Allow to mount a custom yarn config
RUN mkdir /yarn-config \
    && touch /yarn-config/.yarnrc \
    && ln -s /yarn-config/.yarnrc /usr/local/share/.yarnrc

# Add git, needed for yarn
RUN apk add --no-cache bash git openssh

COPY ./ /srv

WORKDIR /srv/dist
EXPOSE 80 443 8080
CMD ["node", "--max_old_space_size=4096", "./server.js"]
USER node
