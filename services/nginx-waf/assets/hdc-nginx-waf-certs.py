#!/usr/bin/env python3
"""hdc nginx-waf certificate HA tool (managed by hdc — do not edit on the host).

Deployed by `hdc run service nginx-waf maintain` (hdc-clumps services/nginx-waf/lib/cert-ha.mjs).
Config: /etc/hdc/nginx-waf-certs.json (peers in priority order, alert settings).

Subcommands (run as root):
  renew [--dry-run] [--simulate-down ID[,ID]] [--force]
        Leader-aware `certbot renew`. Priority 0 renews; a lower-priority node renews only when every
        higher-priority node is unreachable, has not completed a renew run within takeover_after_hours,
        or the fleet has a certificate within takeover_days of expiry. A fleet-wide lease (one lock
        file per node, taken on every reachable node) ensures two nodes never renew at once.
  check [--quiet]
        Daily: compare fingerprints/expiry with peers, push lineages where this node holds the newest
        valid certificate, alert (journal + mail) only when the set of problems changes.
  push [--lineage NAME | --all]
        Push lineage(s) to peers when this node's copy is newer (or the peer lacks it).
  deploy-hook
        certbot deploy hook ($RENEWED_LINEAGE): reload local nginx, push the lineage to peers.
  status
        JSON status of this node.
  serve            (SSH forced command, runs as the hdc user; re-execs itself under sudo)
  serve-root CMD   (internal)
"""
import datetime as _dt
import fcntl
import hashlib
import io
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

CONFIG_PATH = os.environ.get("HDC_NGINX_WAF_CERTS_CONFIG", "/etc/hdc/nginx-waf-certs.json")
LE_DIR = os.environ.get("HDC_LE_DIR", "/etc/letsencrypt")
STATE_DIR = os.environ.get("HDC_NGINX_WAF_CERTS_STATE", "/var/lib/hdc-nginx-waf-certs")
SELF_PATH = "/usr/local/sbin/hdc-nginx-waf-certs"
LOCAL_LOCK = os.path.join(STATE_DIR, "local.lock")
PUSH_LOCK = os.path.join(STATE_DIR, "push.lock")
LEASE_FILE = os.path.join(STATE_DIR, "renew.lease")
RENEW_STATE = os.path.join(STATE_DIR, "last-renew.json")
ALERT_STATE = os.path.join(STATE_DIR, "alert-state.json")
LEASE_TTL = 3 * 3600
SSH_TIMEOUT = 20
TAG = "hdc-nginx-waf-certs"


# ---------------------------------------------------------------- helpers

def log(msg):
    sys.stderr.write(f"{TAG}: {msg}\n")
    sys.stderr.flush()


def now():
    return int(time.time())


def load_config():
    with open(CONFIG_PATH, encoding="utf-8") as f:
        cfg = json.load(f)
    nodes = sorted(cfg.get("nodes", []), key=lambda n: (n.get("priority", 99), n.get("id", "")))
    cfg["nodes"] = nodes
    cfg.setdefault("warn_days", 14)
    cfg.setdefault("takeover_days", 21)
    cfg.setdefault("takeover_after_hours", 36)
    cfg.setdefault("ssh_user", "hdc")
    cfg.setdefault("ssh_key", "/etc/hdc/nginx-waf-certs/id_ed25519")
    return cfg


def self_node(cfg):
    for n in cfg["nodes"]:
        if n["id"] == cfg["self"]:
            return n
    raise SystemExit(f"self {cfg.get('self')!r} not in nodes")


def peers(cfg):
    return [n for n in cfg["nodes"] if n["id"] != cfg["self"]]


def read_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, sort_keys=True)
    os.replace(tmp, path)


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def openssl_cert_info(path):
    r = run(["openssl", "x509", "-in", path, "-noout", "-fingerprint", "-sha256", "-enddate",
             "-ext", "subjectAltName"])
    if r.returncode != 0:
        return None
    fp = end = None
    sans = []
    for line in r.stdout.splitlines():
        line = line.strip()
        if "Fingerprint=" in line:
            fp = line.split("=", 1)[1]
        elif line.startswith("notAfter="):
            end = line.split("=", 1)[1]
        elif "DNS:" in line:
            sans = sorted(p.strip()[4:] for p in line.split(",") if p.strip().startswith("DNS:"))
    if not fp or not end:
        return None
    try:
        exp = int(_dt.datetime.strptime(end, "%b %d %H:%M:%S %Y %Z")
                  .replace(tzinfo=_dt.timezone.utc).timestamp())
    except ValueError:
        exp = 0
    return {"fp": fp, "not_after": end, "expires": exp, "sans": sans}


def key_matches(cert_path, key_path):
    a = run(["openssl", "x509", "-in", cert_path, "-noout", "-pubkey"])
    b = run(["openssl", "pkey", "-in", key_path, "-pubout"])
    return a.returncode == 0 and b.returncode == 0 and a.stdout.strip() == b.stdout.strip()


def lineages():
    live = os.path.join(LE_DIR, "live")
    if not os.path.isdir(live):
        return []
    return sorted(d for d in os.listdir(live) if os.path.isdir(os.path.join(live, d)))


def lineage_info(name):
    base = os.path.join(LE_DIR, "live", name)
    info = openssl_cert_info(os.path.join(base, "fullchain.pem"))
    if not info:
        return {"present": False}
    info["present"] = True
    info["key_ok"] = key_matches(os.path.join(base, "fullchain.pem"), os.path.join(base, "privkey.pem"))
    conf = os.path.join(LE_DIR, "renewal", f"{name}.conf")
    info["renewal_conf"] = os.path.isfile(conf)
    info["renewal_sha"] = ""
    if info["renewal_conf"]:
        with open(conf, "rb") as f:
            info["renewal_sha"] = hashlib.sha256(f.read()).hexdigest()
    info["valid"] = info["key_ok"] and info["expires"] > now()
    return info


def local_status(cfg):
    certs = {n: lineage_info(n) for n in lineages()}
    accounts = []
    acc = os.path.join(LE_DIR, "accounts")
    for root, dirs, _files in os.walk(acc):
        if os.path.isfile(os.path.join(root, "private_key.json")):
            accounts.append(os.path.relpath(root, acc))
    return {
        "id": cfg["self"],
        "time": now(),
        "certs": certs,
        "accounts": sorted(accounts),
        "renew": read_json(RENEW_STATE, {}),
        "lease": read_json(LEASE_FILE, None),
    }


# ---------------------------------------------------------------- ssh to peers

def ssh_cmd(cfg, node, remote_cmd):
    known = os.path.join(STATE_DIR, "known_hosts")
    return [
        "ssh", "-i", cfg["ssh_key"], "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
        "-o", "StrictHostKeyChecking=accept-new", "-o", f"UserKnownHostsFile={known}",
        "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=3",
        f"{node.get('user') or cfg['ssh_user']}@{node['host']}", remote_cmd,
    ]


def peer_call(cfg, node, remote_cmd, stdin_bytes=None, timeout=SSH_TIMEOUT):
    try:
        r = subprocess.run(ssh_cmd(cfg, node, remote_cmd), input=stdin_bytes,
                           capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return 124, b"", b"timeout"
    return r.returncode, r.stdout, r.stderr


def peer_status(cfg, node, simulate_down=()):
    if node["id"] in simulate_down:
        return None
    rc, out, err = peer_call(cfg, node, "status")
    if rc != 0:
        log(f"peer {node['id']} unreachable: {err.decode(errors='replace').strip()[:200]}")
        return None
    try:
        return json.loads(out.decode())
    except ValueError:
        return None


# ---------------------------------------------------------------- lease (fleet lock)

def lease_acquire_local(holder, ttl=LEASE_TTL):
    os.makedirs(STATE_DIR, exist_ok=True)
    cur = read_json(LEASE_FILE, None)
    if cur and cur.get("holder") != holder and cur.get("until", 0) > now():
        return False, cur
    write_json(LEASE_FILE, {"holder": holder, "since": now(), "until": now() + ttl})
    return True, None


def lease_release_local(holder):
    cur = read_json(LEASE_FILE, None)
    if cur and cur.get("holder") == holder:
        try:
            os.remove(LEASE_FILE)
        except OSError:
            pass


def fleet_lease(cfg, simulate_down=()):
    """Take the lease on self + every reachable peer (priority order). Returns list of holders or None."""
    holder = cfg["self"]
    taken = []
    with local_lock():
        ok, cur = lease_acquire_local(holder)
    if not ok:
        log(f"lease held locally by {cur.get('holder')}; not renewing")
        return None
    taken.append(None)
    for node in peers(cfg):
        if node["id"] in simulate_down:
            continue
        rc, out, err = peer_call(cfg, node, f"lease-acquire {holder}")
        if rc == 0:
            taken.append(node)
        elif rc == 3:
            log(f"lease held on {node['id']} ({out.decode(errors='replace').strip()}); not renewing")
            fleet_release(cfg, taken)
            return None
        else:
            log(f"{node['id']} unreachable for lease (rc={rc}); continuing without it")
    return taken


def fleet_release(cfg, taken):
    holder = cfg["self"]
    for node in taken:
        if node is None:
            with local_lock():
                lease_release_local(holder)
        else:
            peer_call(cfg, node, f"lease-release {holder}")


class local_lock:
    path = LOCAL_LOCK

    def __enter__(self):
        os.makedirs(STATE_DIR, exist_ok=True)
        self.f = open(self.path, "w")
        fcntl.flock(self.f, fcntl.LOCK_EX)
        return self

    def __exit__(self, *a):
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


class push_lock(local_lock):
    """Serialises outgoing syncs on this node (never held while waiting on a peer's receive lock)."""
    path = PUSH_LOCK


# ---------------------------------------------------------------- lineage transfer

def lineage_tar(name):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for rel in (f"live/{name}", f"archive/{name}", f"renewal/{name}.conf"):
            p = os.path.join(LE_DIR, rel)
            if os.path.lexists(p):
                tar.add(p, arcname=rel)
    return buf.getvalue()


def accounts_tar():
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        p = os.path.join(LE_DIR, "accounts")
        if os.path.isdir(p):
            tar.add(p, arcname="accounts")
    return buf.getvalue()


def safe_members(tar, allowed_prefixes):
    for m in tar.getmembers():
        n = m.name
        if n.startswith("/") or ".." in n.split("/"):
            raise ValueError(f"unsafe path {n}")
        if not any(n == p or n.startswith(p + "/") for p in allowed_prefixes):
            raise ValueError(f"unexpected path {n}")
        if m.issym():
            tgt = os.path.normpath(os.path.join(os.path.dirname(n), m.linkname))
            if tgt.startswith("..") or tgt.startswith("/"):
                raise ValueError(f"unsafe link {n} -> {m.linkname}")
        elif not (m.isfile() or m.isdir()):
            raise ValueError(f"unsupported member {n}")
    return tar.getmembers()


def nginx_test():
    r = run(["nginx", "-t"])
    return r.returncode == 0, (r.stderr or r.stdout).strip()


def nginx_reload():
    ok, msg = nginx_test()
    if not ok:
        return False, msg
    r = run(["systemctl", "reload", "nginx"])
    return r.returncode == 0, (r.stderr or "").strip()


def receive_lineage(name, data):
    if not name or "/" in name or name.startswith("."):
        raise ValueError("bad lineage name")
    prefixes = [f"live/{name}", f"archive/{name}", f"renewal/{name}.conf"]
    stage = tempfile.mkdtemp(prefix="recv-", dir=STATE_DIR)
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
            members = safe_members(tar, prefixes)
            tar.extractall(stage, members=members, filter="tar") if sys.version_info >= (3, 12) else tar.extractall(stage, members=members)
        new_live = os.path.join(stage, "live", name)
        info = openssl_cert_info(os.path.join(new_live, "fullchain.pem"))
        if not info or not key_matches(os.path.join(new_live, "fullchain.pem"), os.path.join(new_live, "privkey.pem")):
            raise ValueError("incoming certificate/key invalid")
        cur = lineage_info(name)
        if cur.get("present") and cur.get("valid") and cur["expires"] > info["expires"]:
            return {"ok": True, "skipped": "local copy newer"}
        backup = os.path.join(STATE_DIR, "backup")
        os.makedirs(backup, exist_ok=True)
        bpath = os.path.join(backup, f"{name}-{now()}.tar.gz")
        with open(bpath, "wb") as f:
            f.write(lineage_tar(name))
        olds = sorted(p for p in os.listdir(backup) if p.startswith(f"{name}-"))
        for p in olds[:-3]:
            os.remove(os.path.join(backup, p))
        for sub in ("live", "archive"):
            dst = os.path.join(LE_DIR, sub, name)
            os.makedirs(os.path.join(LE_DIR, sub), mode=0o700, exist_ok=True)
            old = f"{dst}.hdc-old"
            if os.path.lexists(old):
                shutil.rmtree(old)
            if os.path.lexists(dst):
                os.rename(dst, old)
            os.rename(os.path.join(stage, sub, name), dst)
        conf_src = os.path.join(stage, "renewal", f"{name}.conf")
        if os.path.isfile(conf_src):
            os.makedirs(os.path.join(LE_DIR, "renewal"), exist_ok=True)
            os.replace(conf_src, os.path.join(LE_DIR, "renewal", f"{name}.conf"))
        ok, msg = nginx_reload()
        if not ok:
            # restore previous copy
            for sub in ("live", "archive"):
                dst = os.path.join(LE_DIR, sub, name)
                old = f"{dst}.hdc-old"
                if os.path.lexists(old):
                    shutil.rmtree(dst, ignore_errors=True)
                    os.rename(old, dst)
            nginx_reload()
            raise RuntimeError(f"nginx -t failed after receive, restored: {msg[:300]}")
        for sub in ("live", "archive"):
            old = os.path.join(LE_DIR, sub, f"{name}.hdc-old")
            if os.path.lexists(old):
                shutil.rmtree(old, ignore_errors=True)
        return {"ok": True, "installed": info["fp"], "expires": info["not_after"]}
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def account_parent_map(account_rels):
    """Group certbot account ids by ACME directory parent path."""
    parents = {}
    for rel in account_rels:
        rel = rel.replace("\\", "/")
        parent = os.path.dirname(rel)
        parents.setdefault(parent, set()).add(os.path.basename(rel))
    return parents


def existing_account_rels(accounts_root):
    found = []
    if not os.path.isdir(accounts_root):
        return found
    for root, _dirs, files in os.walk(accounts_root):
        if "private_key.json" in files:
            found.append(os.path.relpath(root, accounts_root))
    return found


def receive_accounts(data):
    """Install missing ACME *directories*, but never add a second account under one that already has one."""
    stage = tempfile.mkdtemp(prefix="acct-", dir=STATE_DIR)
    added = 0
    skipped = 0
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
            members = safe_members(tar, ["accounts"])
            tar.extractall(stage, members=members, filter="tar") if sys.version_info >= (3, 12) else tar.extractall(stage, members=members)
        src_root = os.path.join(stage, "accounts")
        dest_root = os.path.join(LE_DIR, "accounts")
        existing = account_parent_map(existing_account_rels(dest_root))
        src_accounts = existing_account_rels(src_root)
        skip_ids = set()
        for rel in src_accounts:
            parent = os.path.dirname(rel.replace("\\", "/"))
            acc_id = os.path.basename(rel)
            have = existing.get(parent) or set()
            if have and acc_id not in have:
                skip_ids.add(rel)
                skipped += 1
        for root, dirs, files in os.walk(src_root):
            rel = os.path.relpath(root, src_root)
            rel_posix = rel.replace("\\", "/")
            # If this dir is inside a skipped account id, drop it.
            if any(rel_posix == s or rel_posix.startswith(s + "/") for s in skip_ids):
                dirs[:] = []
                continue
            dst = os.path.join(LE_DIR, "accounts", rel) if rel != "." else os.path.join(LE_DIR, "accounts")
            os.makedirs(dst, mode=0o700, exist_ok=True)
            for fn in files:
                d = os.path.join(dst, fn)
                if not os.path.exists(d):  # never overwrite existing account material
                    shutil.copy2(os.path.join(root, fn), d)
                    os.chmod(d, 0o600 if fn == "private_key.json" else 0o644)
                    added += 1
        return {"ok": True, "added_files": added, "skipped_accounts": skipped}
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def push_lineage_to(cfg, node, name):
    rc, out, err = peer_call(cfg, node, f"receive {name}", stdin_bytes=lineage_tar(name), timeout=90)
    msg = (out or err).decode(errors="replace").strip()
    return rc == 0, msg


def push_accounts_to(cfg, node):
    rc, out, err = peer_call(cfg, node, "receive-accounts", stdin_bytes=accounts_tar(), timeout=60)
    return rc == 0, (out or err).decode(errors="replace").strip()


def newer_than(mine, theirs, my_prio, their_prio):
    """True when my copy should replace theirs.

    Newest *valid* certificate wins; a valid copy always beats an expired or missing one. When both
    are expired (or both valid with the same expiry), the later notAfter wins, then higher priority.
    Same certificate fingerprint: still push when this node has a renewal config the peer lacks (or
    both have one and they differ — higher-priority node wins) so expired lineages can be renewed
    on any node.
    """
    if not mine or not mine.get("present"):
        return False
    if not theirs or not theirs.get("present"):
        return True
    if mine["fp"] == theirs["fp"]:
        ms, ts = mine.get("renewal_sha", ""), theirs.get("renewal_sha", "")
        if not ms or ms == ts:
            return False
        return not ts or my_prio < their_prio
    if mine.get("valid") and not theirs.get("valid"):
        return True
    if not mine.get("valid") and theirs.get("valid"):
        return False
    if mine["expires"] != theirs["expires"]:
        return mine["expires"] > theirs["expires"]
    return my_prio < their_prio


def sync_to_peers(cfg, only=None, simulate_down=()):
    """Push lineages where this node is newest. Returns (actions, problems, peer_statuses)."""
    me = local_status(cfg)
    my_prio = self_node(cfg).get("priority", 0)
    actions, problems, statuses = [], [], {}
    for node in peers(cfg):
        st = peer_status(cfg, node, simulate_down)
        statuses[node["id"]] = st
        if st is None:
            problems.append(f"peer {node['id']} unreachable")
            continue
        # Only push an ACME directory the peer has no account for (never add a second account).
        me_parents = account_parent_map(me.get("accounts") or [])
        peer_parents = account_parent_map(st.get("accounts") or [])
        if any(parent not in peer_parents for parent in me_parents):
            ok, msg = push_accounts_to(cfg, node)
            actions.append(f"accounts -> {node['id']}: {'ok' if ok else 'FAILED ' + msg[:200]}")
            if not ok:
                problems.append(f"account sync to {node['id']} failed")
        for name, info in me["certs"].items():
            if only and name not in only:
                continue
            theirs = st.get("certs", {}).get(name)
            if newer_than(info, theirs, my_prio, node.get("priority", 99)):
                ok, msg = push_lineage_to(cfg, node, name)
                actions.append(f"{name} -> {node['id']}: {'ok' if ok else 'FAILED ' + msg[:200]}")
                if not ok:
                    problems.append(f"push {name} to {node['id']} failed: {msg[:160]}")
        # pull lineages where the peer holds the newest valid copy (or we lack it)
        for name, theirs in st.get("certs", {}).items():
            if only and name not in only:
                continue
            mine = lineage_info(name) if name in me["certs"] else None
            if newer_than(theirs, mine, node.get("priority", 99), my_prio):
                ok, msg = pull_lineage_from(cfg, node, name)
                actions.append(f"{name} <- {node['id']}: {'ok' if ok else 'FAILED ' + msg[:200]}")
                if not ok:
                    problems.append(f"pull {name} from {node['id']} failed: {msg[:160]}")
                else:
                    me["certs"][name] = lineage_info(name)
    return actions, problems, statuses


def pull_lineage_from(cfg, node, name):
    rc, out, err = peer_call(cfg, node, f"send {name}", timeout=90)
    if rc != 0:
        return False, err.decode(errors="replace").strip()
    try:
        with local_lock():
            res = receive_lineage(name, out)
        return True, json.dumps(res)
    except Exception as e:  # noqa: BLE001
        return False, str(e)


# ---------------------------------------------------------------- alerts

def send_alert(cfg, subject, body):
    run(["logger", "-t", TAG, "-p", "user.warning", f"{subject}: {body[:900]}"])
    alert = cfg.get("alert", {}) or {}
    to = [t for t in alert.get("mail_to", []) if t]
    if to and shutil.which("sendmail"):
        frm = alert.get("mail_from") or f"{TAG}@{socket.getfqdn()}"
        msg = (f"From: {frm}\nTo: {', '.join(to)}\nSubject: [hdc] {subject}\n"
               f"Content-Type: text/plain; charset=utf-8\n\n{body}\n")
        r = subprocess.run(["/usr/sbin/sendmail", "-t", "-i"], input=msg, text=True, capture_output=True)
        if r.returncode != 0:
            log(f"sendmail failed: {r.stderr.strip()[:200]}")
    url = alert.get("uptime_kuma_push_url") or ""
    if url:
        try:
            urllib.request.urlopen(f"{url}?status=down&msg={urllib.request.quote(subject[:200])}", timeout=10)
        except Exception as e:  # noqa: BLE001
            log(f"uptime kuma push failed: {e}")


def kuma_ok(cfg):
    url = (cfg.get("alert", {}) or {}).get("uptime_kuma_push_url") or ""
    if url:
        try:
            urllib.request.urlopen(f"{url}?status=up&msg=OK", timeout=10)
        except Exception as e:  # noqa: BLE001
            log(f"uptime kuma push failed: {e}")


def report_problems(cfg, problems, context):
    """Alert only when the problem set for this context changes (new problems, or all cleared)."""
    allstate = read_json(ALERT_STATE, {})
    state = allstate.get(context, {"problems": []})
    prev = set(state.get("problems", []))
    cur = set(problems)
    if cur != prev:
        host = cfg["self"]
        if cur:
            new = sorted(cur - prev)
            body = (f"Node: {host}\nContext: {context}\n\nCurrent problems:\n  - " + "\n  - ".join(sorted(cur))
                    + (f"\n\nNew since last check:\n  - " + "\n  - ".join(new) if new else "")
                    + ("\n\nResolved:\n  - " + "\n  - ".join(sorted(prev - cur)) if prev - cur else ""))
            send_alert(cfg, f"nginx-waf certs: {len(cur)} problem(s) on {host}", body)
        else:
            send_alert(cfg, f"nginx-waf certs: all clear on {host}",
                       f"Node: {host}\nResolved:\n  - " + "\n  - ".join(sorted(prev)))
        allstate[context] = {"problems": sorted(cur), "changed": now()}
        write_json(ALERT_STATE, allstate)
    if not cur and context == "daily check":
        kuma_ok(cfg)


# ---------------------------------------------------------------- subcommands

def fleet_cert_min_days(statuses):
    m = None
    for st in statuses:
        if not st:
            continue
        for name, c in st.get("certs", {}).items():
            if c.get("present") and c.get("renewal_conf", True):
                d = (c["expires"] - now()) / 86400
                m = d if m is None else min(m, d)
    return m


def should_renew(cfg, simulate_down=(), force=False):
    me = self_node(cfg)
    if force:
        return True, "forced"
    if me.get("priority", 0) == 0:
        return True, "leader"
    higher = [n for n in cfg["nodes"] if n.get("priority", 99) < me.get("priority", 0)]
    mine = local_status(cfg)
    for node in higher:
        st = peer_status(cfg, node, simulate_down)
        if st is None:
            continue
        last = (st.get("renew") or {}).get("finished", 0)
        if now() - last > cfg["takeover_after_hours"] * 3600:
            log(f"{node['id']} reachable but no renew run for {(now() - last) // 3600}h")
            continue
        mind = fleet_cert_min_days([st, mine])
        if mind is not None and mind < cfg["takeover_days"]:
            log(f"{node['id']} reachable but fleet has a cert with {mind:.1f}d left (<{cfg['takeover_days']}d)")
            continue
        return False, f"deferring to healthy higher-priority node {node['id']}"
    return True, "takeover: all higher-priority nodes unreachable or failing"



def pems_tar(name):
    live = os.path.join(LE_DIR, "live", name)
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for fn in ("fullchain.pem", "privkey.pem"):
            path = os.path.join(live, fn)
            if not os.path.isfile(path):
                raise FileNotFoundError(path)
            # live/ files are typically symlinks into archive/; pack the real bytes
            tar.add(os.path.realpath(path), arcname=fn)
    return buf.getvalue()


def distribute_targets(cfg, only=None):
    out = []
    for t in cfg.get("distribute") or []:
        names = list(t.get("cert_names") or [])
        if only:
            names = [n for n in names if n in only]
        if names and t.get("host"):
            out.append({**t, "cert_names": names})
    return out


def push_to_distribute_target(cfg, target, name):
    node = {"id": target.get("id") or target["host"], "host": target["host"],
            "user": target.get("user") or "root"}
    rc, out, err = peer_call(cfg, node, "receive", stdin_bytes=pems_tar(name), timeout=60)
    msg = (out or err).decode(errors="replace").strip()
    return rc == 0, msg


def distribute_certs(cfg, only=None):
    actions, problems = [], []
    for target in distribute_targets(cfg, only):
        for name in target["cert_names"]:
            if not os.path.isfile(os.path.join(LE_DIR, "live", name, "fullchain.pem")):
                problems.append(f"distribute {name} -> {target.get('id')}: lineage missing locally")
                continue
            try:
                ok, msg = push_to_distribute_target(cfg, target, name)
            except Exception as e:  # noqa: BLE001
                ok, msg = False, repr(e)
            actions.append(f"distribute {name} -> {target.get('id')}: {'ok' if ok else 'FAILED ' + msg[:200]}")
            if not ok:
                problems.append(f"distribute {name} to {target.get('id')} failed")
    return actions, problems


def cmd_renew(cfg, args):
    dry = "--dry-run" in args
    force = "--force" in args
    sim = parse_sim(args)
    go, why = should_renew(cfg, sim, force)
    log(f"renew decision: {'RENEW' if go else 'skip'} ({why})")
    if not go:
        return 0
    taken = fleet_lease(cfg, sim)
    if taken is None:
        return 0
    started = now()
    try:
        cmd = ["certbot", "renew", "--non-interactive", "--no-random-sleep-on-renew"]
        if dry:
            cmd.append("--dry-run")
        r = run(cmd)
        out = (r.stdout + r.stderr)
        sys.stderr.write(out[-6000:])
        failed = []
        for line in out.splitlines():
            line = line.strip()
            if line.startswith("/etc/letsencrypt/live/") and "(failure)" in line:
                failed.append(line.split("/")[4])
        state = {"started": started, "finished": now(), "ok": r.returncode == 0, "failed": sorted(set(failed)),
                 "dry_run": dry, "reason": why}
        if not dry:
            write_json(RENEW_STATE, state)
            if not failed and r.returncode == 0:
                # make sure peers got anything renewed (deploy-hook also pushes)
                actions, problems, _ = sync_to_peers(cfg, simulate_down=sim)
                for a in actions:
                    log(a)
                d_actions, d_problems = distribute_certs(cfg)
                for a in d_actions:
                    log(a)
                problems.extend(d_problems)
            probs = [f"renewal failed on {cfg['self']}: {n}" for n in state["failed"]]
            if r.returncode != 0 and not probs:
                probs = [f"certbot renew exited {r.returncode} on {cfg['self']}"]
            report_problems(cfg, probs, "renew")
        else:
            log(f"dry-run result: rc={r.returncode} failed={state['failed']}")
        return 0 if r.returncode == 0 else 1
    finally:
        fleet_release(cfg, taken)


def cmd_check(cfg, args):
    sim = parse_sim(args)
    with push_lock():
        actions, problems, statuses = sync_to_peers(cfg, simulate_down=sim)
    for a in actions:
        log(a)
    me = local_status(cfg)
    warn = cfg["warn_days"]
    for name, c in me["certs"].items():
        if not c.get("present"):
            problems.append(f"{name}: unreadable on {cfg['self']}")
            continue
        days = (c["expires"] - now()) / 86400
        if days < warn:
            problems.append(f"{name}: expires in {days:.0f}d ({c['not_after']})")
        if not c.get("key_ok"):
            problems.append(f"{name}: key/cert mismatch on {cfg['self']}")
    # mismatches remaining after sync (re-read peers that we pushed to)
    for node in peers(cfg):
        st = peer_status(cfg, node, sim) if actions else statuses.get(node["id"])
        if not st:
            continue
        for name, c in me["certs"].items():
            t = st.get("certs", {}).get(name)
            if not t or not t.get("present"):
                if c.get("valid"):
                    problems.append(f"{name}: missing on {node['id']}")
            elif t.get("fp") != c.get("fp"):
                problems.append(f"{name}: fingerprint differs from {node['id']}")
    # renewal failures recorded by other nodes (this node's own failures are alerted by `renew`)
    for st in [statuses.get(n["id"]) for n in peers(cfg)]:
        if not st:
            continue
        rs = st.get("renew") or {}
        for n in rs.get("failed", []):
            problems.append(f"renewal failed on {st['id']}: {n}")
    leader_fresh = any(
        st and now() - ((st.get("renew") or {}).get("finished", 0)) < cfg["takeover_after_hours"] * 3600
        for st in [me] + list(statuses.values()))
    if not leader_fresh:
        problems.append(f"no node completed a renew run in {cfg['takeover_after_hours']}h")
    # Fleet-wide problems are reported by the highest-priority reachable node only (no duplicate mail);
    # other nodes report only what is local to them (or everything when no higher node is reachable).
    reporter = cfg["self"]
    for n in cfg["nodes"]:
        if n["id"] == cfg["self"] or statuses.get(n["id"]):
            reporter = n["id"]
            break
    if reporter != cfg["self"]:
        problems = [p for p in problems if cfg["self"] in p or p.startswith(("push ", "pull "))]
    report_problems(cfg, sorted(set(problems)), "daily check")
    if "--quiet" not in args:
        print(json.dumps({"actions": actions, "problems": sorted(set(problems))}, indent=1))
    return 0


def cmd_push(cfg, args):
    only = None
    if "--lineage" in args:
        only = {args[args.index("--lineage") + 1]}
    with push_lock():
        actions, problems, _ = sync_to_peers(cfg, only=only, simulate_down=parse_sim(args))
    for a in actions:
        log(a)
    for p in problems:
        log(f"problem: {p}")
    d_actions, d_problems = distribute_certs(cfg, only)
    for a in d_actions:
        log(a)
        actions.append(a)
    # Best-effort: the receiver (e.g. mosquitto) may not be installed yet.
    if d_problems:
        log("; ".join(d_problems))
    print(json.dumps({"actions": actions, "problems": problems, "distribute_problems": d_problems}, indent=1))
    return 0 if not any("failed" in p for p in problems) else 1


def cmd_deploy_hook(cfg, args):
    lin = os.environ.get("RENEWED_LINEAGE", "")
    name = os.path.basename(lin.rstrip("/"))
    ok, msg = nginx_reload()
    if not ok:
        send_alert(cfg, f"nginx-waf certs: nginx reload failed on {cfg['self']}", msg)
    if name:
        with push_lock():
            actions, problems, _ = sync_to_peers(cfg, only={name})
        for a in actions:
            log(a)
        if name:
            d_actions, d_problems = distribute_certs(cfg, {name})
            for a in d_actions:
                log(a)
            if d_problems:
                log("; ".join(d_problems))
    return 0



def cmd_distribute(cfg, args):
    only = set(args) if args else None
    actions, problems = distribute_certs(cfg, only)
    for a in actions:
        log(a)
    print(json.dumps({"actions": actions, "problems": problems}, indent=1))
    return 0 if not problems else 1


def parse_sim(args):
    if "--simulate-down" in args:
        return set(args[args.index("--simulate-down") + 1].split(","))
    return set()



ACME_HTTP01_WEBROOT = "/var/www/letsencrypt/.well-known/acme-challenge"
ACME_HTTP01_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def _acme_http01_path(token):
    if not ACME_HTTP01_TOKEN_RE.fullmatch(token):
        raise ValueError("bad token")
    path = os.path.join(ACME_HTTP01_WEBROOT, token)
    if os.path.dirname(os.path.abspath(path)) != os.path.abspath(ACME_HTTP01_WEBROOT):
        raise ValueError("bad token")
    return path


def acme_http01_put(token):
    path = _acme_http01_path(token)
    data = sys.stdin.buffer.read()
    if not data or len(data) > 4096:
        print("bad validation", file=sys.stderr)
        return 2
    os.makedirs(ACME_HTTP01_WEBROOT, mode=0o755, exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)
    return 0


def acme_http01_clear(token):
    path = _acme_http01_path(token)
    try:
        os.remove(path)
    except FileNotFoundError:
        pass
    return 0


def cmd_serve(cfg, args):
    orig = os.environ.get("SSH_ORIGINAL_COMMAND", "")
    os.execvp("sudo", ["sudo", "-n", SELF_PATH, "serve-root", orig])


def cmd_serve_root(cfg, args):
    orig = args[0] if args else ""
    parts = shlex.split(orig)
    if not parts:
        print("no command", file=sys.stderr)
        return 2
    verb, rest = parts[0], parts[1:]
    known_ids = {n["id"] for n in cfg["nodes"]}
    if verb == "status" and not rest:
        print(json.dumps(local_status(cfg)))
        return 0
    if verb in ("lease-acquire", "lease-release") and len(rest) == 1 and rest[0] in known_ids:
        with local_lock():
            if verb == "lease-release":
                lease_release_local(rest[0])
                return 0
            ok, cur = lease_acquire_local(rest[0])
        if ok:
            return 0
        print(cur.get("holder"))
        return 3
    if verb == "receive" and len(rest) == 1:
        data = sys.stdin.buffer.read()
        with local_lock():
            res = receive_lineage(rest[0], data)
        print(json.dumps(res))
        return 0
    if verb == "send" and len(rest) == 1 and rest[0] in lineages():
        sys.stdout.buffer.write(lineage_tar(rest[0]))
        return 0
    if verb == "receive-accounts" and not rest:
        data = sys.stdin.buffer.read()
        with local_lock():
            res = receive_accounts(data)
        print(json.dumps(res))
        return 0
    if verb == "acme-http01-put" and len(rest) == 1:
        try:
            return acme_http01_put(rest[0])
        except ValueError:
            print("bad token", file=sys.stderr)
            return 2
    if verb == "acme-http01-clear" and len(rest) == 1:
        try:
            return acme_http01_clear(rest[0])
        except ValueError:
            print("bad token", file=sys.stderr)
            return 2
    print(f"refused: {verb}", file=sys.stderr)
    return 2


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    sub, args = argv[1], argv[2:]
    if sub == "serve":
        return cmd_serve(None, args)
    cfg = load_config()
    if os.geteuid() != 0 and not os.environ.get("HDC_NGINX_WAF_CERTS_TEST"):
        print("must run as root", file=sys.stderr)
        return 2
    handlers = {
        "renew": cmd_renew, "check": cmd_check, "push": cmd_push, "deploy-hook": cmd_deploy_hook,
        "distribute": cmd_distribute,
        "status": lambda c, a: print(json.dumps(local_status(c), indent=1)) or 0,
        "serve-root": cmd_serve_root,
    }
    if sub not in handlers:
        print(__doc__)
        return 2
    try:
        return handlers[sub](cfg, args)
    except Exception as e:  # noqa: BLE001
        log(f"{sub} failed: {e}")
        if sub in ("renew", "check", "deploy-hook"):
            send_alert(cfg, f"nginx-waf certs: {sub} crashed on {cfg.get('self')}", repr(e))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
