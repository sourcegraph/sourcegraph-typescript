#!/bin/bash
set -ex
cd $(dirname "${BASH_SOURCE[0]}")

# Install dependencies
yarn

# Build & publish extension
src ext publish

# Compile Server
yarn run build-server

# Build image
VERSION=$(printf "%05d" $BUILDKITE_BUILD_NUMBER)_$(date +%Y-%m-%d)_$(git rev-parse --short HEAD)
docker build -t sourcegraph/lang-typescript:$VERSION .

# Upload to Docker Hub
docker push sourcegraph/lang-typescript:$VERSION
docker tag sourcegraph/lang-typescript:$VERSION sourcegraph/lang-typescript:latest
docker push sourcegraph/lang-typescript:latest

# Deploy to prod
# CONTEXT=gke_sourcegraph-dev_us-central1-f_main-cluster-5
# kubectl --context=$CONTEXT --namespace=prod set image deployment/lang-typescript "lang-typescript=sourcegraph/lang-typescript:$VERSION"
# kubectl --context=$CONTEXT --namespace=prod rollout status deployment/lang-typescript

# Trigger Deploybot
curl http://deploy-bot.sourcegraph.com/set-branch-version -F "token=$DEPLOY_BOT_TOKEN" -F "branch=lang-typescript/master" -F "version=$VERSION" -F "user=$BUILDKITE_BUILD_CREATOR_EMAIL"

