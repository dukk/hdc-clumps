import { createConfigureExec } from "../../postfix-relay/lib/postfix-relay-configure.mjs";
import { renderHdcNginxInclude, renderSiteVhost, siteId, staticRoot } from "./nginx-render.mjs";

export { createConfigureExec };

/**
 * @param {string} s
 */
function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {ReturnType<typeof createConfigureExec>} exec
 * @param {string} cmd
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 */
function runChecked(exec, cmd, log) {
  log.info(`${exec.label}: ${cmd.split("\n")[0].slice(0, 120)}`);
  const r = exec.run(cmd, { capture: true });
  if (r.status !== 0) {
    const detail = `${r.stderr}${r.stdout}`.trim() || `exit ${r.status}`;
    throw new Error(detail);
  }
  return r;
}

/**
 * @param {ReturnType<typeof createConfigureExec>} exec
 * @param {string} remotePath
 * @param {string} content
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} log
 */
function uploadFile(exec, remotePath, content, log) {
  const b64 = Buffer.from(content, "utf8").toString("base64");
  runChecked(exec, `echo ${shellQuote(b64)} | base64 -d > ${shellQuote(remotePath)}`, log);
}

/**
 * Minimal port-80 vhost so certbot http-01 can complete before TLS site configs exist.
 * @param {object} opts
 * @param {ReturnType<typeof createConfigureExec>} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {string} opts.webroot
 */
export function ensureAcmeBootstrapVhost(opts) {
  const { exec, log, webroot } = opts;
  const conf = [
    "# hdc nginx — temporary ACME bootstrap",
    "server {",
    "    listen 80 default_server;",
    "    listen [::]:80 default_server;",
    "    server_name _;",
    `    location ^~ /.well-known/acme-challenge/ {`,
    `        root ${webroot};`,
    '        default_type "text/plain";',
    "    }",
    "    location / {",
    "        return 404;",
    "    }",
    "}",
    "",
  ].join("\n");
  const avail = "/etc/nginx/sites-available/hdc-acme-bootstrap.conf";
  uploadFile(exec, avail, conf, log);
  runChecked(exec, `ln -sf ${shellQuote(avail)} /etc/nginx/sites-enabled/hdc-acme-bootstrap.conf`, log);
  runChecked(exec, "nginx -t && systemctl reload nginx", log);
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof createConfigureExec>} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {ReturnType<typeof import("./deployments.mjs").nginxGlobalSettings>} opts.global
 * @param {boolean} [opts.dns01]
 */
export function installNginxBase(opts) {
  const { exec, log, global, dns01 } = opts;
  const pkgs = ["nginx", "certbot", "python3-certbot-nginx"];
  if (dns01) pkgs.push("python3-certbot-dns-rfc2136");
  runChecked(
    exec,
    `export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y ${pkgs.join(" ")}`,
    log,
  );
  runChecked(exec, "mkdir -p /etc/nginx/hdc /var/www/letsencrypt", log);
  runChecked(exec, "rm -f /etc/nginx/sites-enabled/default", log);
  const include = renderHdcNginxInclude({
    clientMaxBodySize: global.clientMaxBodySize,
    proxyReadTimeout: global.proxyReadTimeout,
    proxyConnectTimeout: global.proxyConnectTimeout,
  });
  uploadFile(exec, "/etc/nginx/hdc/web-global.conf", include, log);
  runChecked(
    exec,
    `grep -q 'hdc/web-global.conf' /etc/nginx/nginx.conf || ` +
      `sed -i '/http {/a\\    include /etc/nginx/hdc/web-global.conf;' /etc/nginx/nginx.conf`,
    log,
  );
  runChecked(
    exec,
    "test -f /etc/letsencrypt/options-ssl-nginx.conf || " +
      "cp /usr/lib/python3/dist-clumps/certbot_nginx/_internal/tls_configs/options-ssl-nginx.conf " +
      "/etc/letsencrypt/options-ssl-nginx.conf 2>/dev/null || true",
    log,
  );
  runChecked(
    exec,
    "test -f /etc/letsencrypt/ssl-dhparams.pem || " +
      "openssl dhparam -out /etc/letsencrypt/ssl-dhparams.pem 2048 2>/dev/null || true",
    log,
  );
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof createConfigureExec>} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {ReturnType<typeof import("./deployments.mjs").nginxGlobalSettings>} opts.global
 * @param {Record<string, unknown>[]} opts.sites
 * @param {boolean} [opts.pruneStaleSites] Remove hdc-* vhosts on host not in sites[] (default true)
 */
export function configureNginxSites(opts) {
  const { exec, log, global, sites, pruneStaleSites = true } = opts;
  runChecked(exec, "mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled", log);

  const http01 = global.challenge === "http-01";
  /** @type {string[]} */
  const enabledIds = [];

  for (const site of sites) {
    const id = siteId(site);
    const docroot = staticRoot(site);
    if (docroot) {
      runChecked(exec, `mkdir -p ${shellQuote(docroot)}`, log);
    }
    const vhost = renderSiteVhost({
      site,
      http01Acme: http01,
      webroot: global.webroot,
    });
    const avail = `/etc/nginx/sites-available/hdc-${id}.conf`;
    uploadFile(exec, avail, vhost, log);
    runChecked(exec, `ln -sf ${shellQuote(avail)} /etc/nginx/sites-enabled/hdc-${id}.conf`, log);
    enabledIds.push(id);
  }

  if (pruneStaleSites) {
    const list = runChecked(
      exec,
      "ls -1 /etc/nginx/sites-enabled/hdc-*.conf 2>/dev/null || true",
      log,
    );
    const existing = list.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((p) => {
        const m = p.match(/hdc-([^.]+)\.conf$/);
        return m ? m[1] : null;
      })
      .filter(Boolean);

    for (const oldId of existing) {
      if (!enabledIds.includes(/** @type {string} */ (oldId))) {
        runChecked(
          exec,
          `rm -f /etc/nginx/sites-enabled/hdc-${oldId}.conf /etc/nginx/sites-available/hdc-${oldId}.conf`,
          log,
        );
        log.info(`removed stale site ${oldId}`);
      }
    }
  }

  runChecked(
    exec,
    "rm -f /etc/nginx/sites-enabled/hdc-acme-bootstrap.conf /etc/nginx/sites-available/hdc-acme-bootstrap.conf",
    log,
  );

  runChecked(exec, "nginx -t", log);
  runChecked(exec, "systemctl enable nginx && systemctl reload nginx", log);
  return { enabled_site_ids: enabledIds, prune_stale_sites: pruneStaleSites };
}

/**
 * Full configure: base + sites.
 * @param {object} opts
 * @param {ReturnType<typeof createConfigureExec>} opts.exec
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {ReturnType<typeof import("./deployments.mjs").nginxGlobalSettings>} opts.global
 * @param {Record<string, unknown>[]} opts.sites
 * @param {boolean} [opts.skipBaseInstall]
 */
export function configureNginx(opts) {
  const { exec, log, global, sites, skipBaseInstall } = opts;
  if (!skipBaseInstall) {
    installNginxBase({ exec, log, global, dns01: global.challenge === "dns-01" });
  }
  const sitesResult = configureNginxSites({ exec, log, global, sites });
  return { ...sitesResult };
}
