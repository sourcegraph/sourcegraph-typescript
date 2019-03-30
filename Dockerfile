FROM node:11.11.0-alpine@sha256:6da4878fc63b98ef5fde771b1f05fec9c796e49d249816fe8d544f336ae89d80

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

WORKDIR /srv/server
EXPOSE 80 443 8080
CMD ["node", "--max_old_space_size=4096", "./dist/server.js"]
USER node
