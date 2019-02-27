# Code intelligence for TypeScript/JavaScript

A Sourcegraph extension that provides code intelligence for TypeScript/JavaScript.

## Usage with private Sourcegraph instances

This extension is configured to talk to a language server over WebSockets. If you are running a
private Sourcegraph instance, you should run your own language server. The server is available as a
Docker image `sourcegraph/lang-typescript` from Docker Hub.

### 🚨 Secure deployment 🚨

We recommend deploying the language server behind an auth proxy or firewall and
treating it like an authenticated user because anyone that connects to the
language server can access resources such as private code that the language
server has access to.

Make sure you set `typescript.sourcegraphUrl` to the URL that the language
server should use to reach Sourcegraph, which is likely different from the URL
that end users use.

### Using Docker

1.  Run the server listening on `ws://localhost:8080`:

    ```sh
    docker run -p 8080:8080 sourcegraph/lang-typescript
    ```

1.  In your Sourcegraph settings, set `typescript.serverUrl` to tell the extension where to connect to the server:

    ```json
    "typescript.serverUrl": "ws://localhost:8080"
    ```

1.  If the URL the server should use to connect to Sourcegraph is different from the end-user URL, set `typescript.sourcegraphUrl`:

    ```json
    "typescript.sourcegraphUrl": "http://host.docker.internal:7080",
    ```

    The above value works for macOS when running the server in a local Docker container. If you're
    running locally on Linux, use the value emitted by this command:

    ```bash
    ip addr show docker0 | grep -Po 'inet \K[\d.]+'
    ```

    The port should match that of the `docker run` command running Sourcegraph.

### Using Kubernetes

If you want to deploy the language server with Kubernetes, your deployment should look like this:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: lang-typescript
spec:
  selector:
    matchLabels:
      app: lang-typescript
  template:
    replicas: 4 # adjust as needed
    metadata:
      labels:
        app: lang-typescript
    spec:
      containers:
        - name: lang-typescript
          image: sourcegraph/lang-typescript
          ports:
            - containerPort: 8080
              name: wss
          env:
            # TLS certificate and key to secure the WebSocket connection (optional)
            - name: TLS_CERT
              value: ... your TLS certificate ...
            - name: TLS_KEY
              value: ... your TLS key ...
          # Resources to provision for the server (adjust as needed)
          resources:
            limits:
              cpu: '4'
              memory: 5Gi
            requests:
              cpu: 500m
              memory: 2Gi
          # Probes the server periodically to see if it is healthy
          livenessProbe:
            initialDelaySeconds: 30
            tcpSocket:
              port: wss
            timeoutSeconds: 5
          readinessProbe:
            tcpSocket:
              port: wss
```

With a corresponding service:

```yaml
apiVersion: v1
kind: Service
metadata:
  labels:
    app: lang-typescript
    deploy: lang-typescript
  name: lang-typescript
spec:
  ports:
    - name: wss
      port: 443
      targetPort: wss
  selector:
    app: lang-typescript
  type: LoadBalancer
```

#### TLS

TLS is optional but recommended for production deployments. It is used if `TLS_KEY` and `TLS_CERT` environment variables are set.

#### Enabling OpenTracing

The server can report spans through OpenTracing to diagnose issues.
If the environment variable `LIGHTSTEP_ACCESS_TOKEN` is set, the server will send tracing data to the given LightStep instance.
Support for other OpenTracing implementations can easily added here.

```diff
  env:
+   - name: LIGHTSTEP_ACCESS_TOKEN
+     value: abcdefg
```

#### Enabling Prometheus metrics

The server exposes metrics on port 6060 that can be scraped by Prometheus.

#### Improving performance with an SSD

To improve performance of dependency installation, the server can be configured to use a mounted SSD at a given directory by setting the `CACHE_DIR` environment variable. The instructions for how to mount a SSD depend on your deployment environment.

1. Add a volume for the mount path of the SSD:

   ```diff
     spec:
   + volumes:
   +   - hostPath:
   +       path: /path/to/mounted/ssd
   +     name: cache-ssd
   ```

   For example, Google Cloud Platform mounts the first SSD disk to `/mnt/disks/ssd0`.

2. Add a volume mount to the container spec:

   ```diff
     image: sourcegraph/lang-typescript
   + volumeMounts:
   +   - mountPath: /mnt/cache
   +     name: cache-ssd
   ```

3. Tell the language server to use the mount as the root for temporary directories:

   ```diff
     env:
   +   - name: CACHE_DIR
   +     value: /mnt/cache
   ```

#### Improving performance with an npm registry proxy

To further speed up dependency installation, all npm registry requests can be proxied through a cache running on the same node.

Example deployment for Kubernetes:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: npm-proxy
spec:
  minReadySeconds: 10
  replicas: 1
  revisionHistoryLimit: 10
  strategy:
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 1
    type: RollingUpdate
  template:
    metadata:
      labels:
        app: npm-proxy
    spec:
      containers:
        - image: sourcegraph/npm-proxy:latest
          name: npm-proxy
          ports:
            - containerPort: 8080
              name: http
          resources:
            limits:
              cpu: '1'
              memory: 1Gi
          volumeMounts:
            - mountPath: /cache
              name: npm-proxy-cache
      volumes:
        - name: npm-proxy-cache
          persistentVolumeClaim:
            claimName: npm-proxy
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  annotations:
    volume.beta.kubernetes.io/storage-class: default
  name: npm-proxy
  namespace: prod
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 100Gi
---
apiVersion: v1
kind: Service
metadata:
  labels:
    app: npm-proxy
  name: npm-proxy
spec:
  ports:
    - name: http
      port: 8080
      targetPort: http
  selector:
    app: npm-proxy
  type: ClusterIP
```

Then define a `.yarnrc` as a config map that points to the proxy:

```yaml
apiVersion: v1
data:
  .yarnrc: |
    # THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
    # yarn lockfile v1


    https-proxy "http://npm-proxy:8080"
    proxy "http://npm-proxy:8080"
    strict-ssl false
kind: ConfigMap
metadata:
  name: yarn-config
  namespace: prod
```

and mount it into the container:

```diff
  name: lang-typescript
+ volumeMounts:
+  - mountPath: /yarn-config
+    name: yarn-config
```

```diff
  spec:
+   volumes:
+     - configMap:
+         name: yarn-config
+       name: yarn-config
```

## Configuration

### Support for dependencies on private packages and git repositories

Dependencies on private npm packages and private registries is supported by setting the `typescript.npmrc` setting.
It contains the same key/value settings as your `.npmrc` file in your home folder, and therefor supports the same scoping to registries and package scopes.
See https://docs.npmjs.com/misc/config#config-settings for more information on what is possible to configure in `.npmrc`.

Example:

```json
"typescript.npmrc": {
  "//registry.npmjs.org/:_authToken": "asfdh21e-1234-asdn-123v-1234asdb2"
}
```

For dependencies on private git repositories, mount an SSH key into `~/.ssh`.

## Contributing

You need NodeJS >=11.1.0 and yarn installed.

```sh
# Install dependencies
yarn
# Build the extension and the server
yarn run build
```

To debug the server, build, then run it locally with `yarn start-server` and point the extension to it through Sourcegraph settings:

```json
"typescript.serverUrl": "ws://localhost:8080"
```

To debug the extension, serve the extension from localhost with `yarn serve-ext` and [sideload it into Sourcegraph](https://docs.sourcegraph.com/extensions/authoring/local_development).
