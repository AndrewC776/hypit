# launchd service templates

`com.hypit.api.plist` and `com.hypit.worker.plist` keep the two control-plane processes running on a
macOS host: the API that accepts jobs and the worker that executes them. They are **templates**, not
installable files. Every host-specific absolute path is written as a `__TOKEN__` so that the copy in
Git describes the shape of the deployment and the copy in `~/Library/LaunchAgents` describes one
machine.

## Nothing here may hold a secret

A plist is world readable, and `launchctl print` echoes the entire job description — label, argv and
environment — to anyone who can run it. So `ProgramArguments` and `EnvironmentVariables` carry only
paths, a port and a policy flag.

Credentials reach the services by reference instead:

- Provider credentials belong to the Runtime Profile's `CredentialStore`. The worker is given the
  profile's **path**; the profile holds `{ store: "os", key }` references and the bytes stay in the
  login keychain.
- Cloudflare Access credentials for the edge Worker are Worker secrets held by Cloudflare. They are
  never present on this host at all.

If a future service needs a secret from disk, give the plist the **path** to a file owned by the
service account with mode `0600` and read it at startup. Do not add the value to the environment.

## Why a LaunchAgent and not a LaunchDaemon

A LaunchDaemon runs as root before login and cannot open the operator's login keychain, which is
where `@hypit/credential-store-os` keeps provider credentials. Running the control plane as root
would also mean every per-job workspace under the jobs root is root-owned.

So both jobs are per-user LaunchAgents in `~/Library/LaunchAgents`, bootstrapped into the `gui`
domain. The cost is that the `gui` domain exists only while the user is logged in: for the services
to come back on their own after a power cut, the host must be set to log that user in automatically
(System Settings, Users & Groups, Automatic login). Without automatic login, a reboot leaves both
services down until someone logs in, and the reboot acceptance check below will fail — correctly.

## Placeholders

| Token | Meaning | Value on the production host |
| --- | --- | --- |
| `__NODE_EXECUTABLE__` | Absolute path to the `node` binary | `/opt/homebrew/bin/node` |
| `__CONTROL_PLANE_CHECKOUT__` | The control-plane checkout root | `~/hypit-work/control-plane/hypit` |
| `__WORK_ROOT__` | Runtime state root: state, jobs, logs, baseline profile, config | `~/hypit-work` |
| `__HYPIT_EXECUTABLE__` | The pinned production Hypit CLI | `/opt/homebrew/bin/hypit` |

Expand `~` yourself. launchd does no tilde expansion and no shell expansion of any kind; a literal
`~` in a plist is a directory named `~`.

`__NODE_EXECUTABLE__` must be absolute because launchd execs `ProgramArguments[0]` directly rather
than searching `PATH`. The `PATH` in `EnvironmentVariables` governs what the job's **children** find
— which is the part that matters, because the worker spawns the Hypit CLI, which resolves `ffprobe`,
`ffmpeg` and `uv` from `PATH`, and launchd's default `PATH` omits Homebrew entirely.

## Preflight

Run these before installing anything. Each one is a failure that otherwise shows up as an opaque
respawn loop.

```sh
CHECKOUT=~/hypit-work/control-plane/hypit
WORK=~/hypit-work

# 1. The directories launchd will not create for you. It creates the log FILES, not their directory.
mkdir -p "$WORK/logs" "$WORK/state" "$WORK/jobs" "$WORK/baseline" "$WORK/config"

# 2. The entry modules named in ProgramArguments actually exist.
ls "$CHECKOUT/services/hypit-api/src/main.ts" "$CHECKOUT/services/hypit-worker/src/main.ts"

# 3. tsx resolves from the checkout root, which is why WorkingDirectory is the root and not the
#    service directory: node resolves the bare `tsx` specifier given to --import against the cwd.
ls "$CHECKOUT/node_modules/tsx" || (cd "$CHECKOUT" && pnpm install --frozen-lockfile)

# 4. The absolute node path you are about to substitute.
which -a node

# 5. The shared Runtime is up and its Managed Programs are ready. The worker refuses jobs until
#    `programs status` reports 2/2, and it does not provision anything per job.
hypit programs status --runtime "$WORK/baseline/hypit.runtime.json"
```

## Install

Substitute the tokens on the way into `~/Library/LaunchAgents`. Keep the substitution in one command
so the installed file and the template never drift by hand-editing:

```sh
CHECKOUT=~/hypit-work/control-plane/hypit
WORK=~/hypit-work
NODE=$(which node)

for label in com.hypit.api com.hypit.worker; do
  sed \
    -e "s|__NODE_EXECUTABLE__|$NODE|g" \
    -e "s|__CONTROL_PLANE_CHECKOUT__|$CHECKOUT|g" \
    -e "s|__WORK_ROOT__|$WORK|g" \
    -e "s|__HYPIT_EXECUTABLE__|/opt/homebrew/bin/hypit|g" \
    "$CHECKOUT/ops/launchd/$label.plist" > ~/Library/LaunchAgents/$label.plist
done

# No token may survive substitution. This prints nothing when the install is complete.
grep -n "__" ~/Library/LaunchAgents/com.hypit.*.plist

plutil -lint ~/Library/LaunchAgents/com.hypit.api.plist ~/Library/LaunchAgents/com.hypit.worker.plist
```

## Bootstrap, bootout, restart

`launchctl load` and `unload` are the deprecated spelling and hide failures behind exit code 0. Use
the domain-target form, which reports what went wrong.

```sh
# Start (both jobs; order does not matter, they meet only through the SQLite store).
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.hypit.api.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.hypit.worker.plist

# Stop and unregister.
launchctl bootout gui/$(id -u)/com.hypit.api
launchctl bootout gui/$(id -u)/com.hypit.worker

# Restart in place after a code change. -k kills the running instance first.
launchctl kickstart -k gui/$(id -u)/com.hypit.api
launchctl kickstart -k gui/$(id -u)/com.hypit.worker

# Inspect: state, last exit status, argv, environment, resolved log paths.
launchctl print gui/$(id -u)/com.hypit.api
```

Editing an installed plist does not change a loaded job. `bootout` then `bootstrap` again — that is
the only way the new file takes effect.

## Acceptance checks

A deployment is not accepted until every one of these passes on the host.

**1. Both jobs are running.**

```sh
launchctl print gui/$(id -u)/com.hypit.api    | grep -E "state = |last exit code"
launchctl print gui/$(id -u)/com.hypit.worker | grep -E "state = |last exit code"
```

Expect `state = running`. A `last exit code` that keeps changing while `state` cycles is a crash
loop; read the error log rather than re-bootstrapping.

**2. The API answers on loopback.**

```sh
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/health   # 200
curl -sS http://127.0.0.1:8787/ready                                      # 200 with a ready body
```

`/ready` is the real check: it reports the store reachable, migrations applied, the worker heartbeat
fresh and the adapter executable present. `/health` only proves the process is alive.

**3. It binds loopback and nothing else.**

```sh
lsof -nP -iTCP:8787 -sTCP:LISTEN
```

Every listening address must read `127.0.0.1:8787`. A `*:8787` row means the service bound all
interfaces and must be stopped immediately.

**4. KeepAlive actually restarts a killed process.**

```sh
PID=$(launchctl print gui/$(id -u)/com.hypit.api | awk '/^\tpid = /{print $3}')
echo "before: $PID"
kill -9 "$PID"
sleep 15   # ThrottleInterval is 10s, so allow for it
launchctl print gui/$(id -u)/com.hypit.api | awk '/^\tpid = /{print "after: " $3}'
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/ready
```

The second PID must differ from the first and `/ready` must return 200. Repeat for
`com.hypit.worker`; there, the additional evidence is that a job the killed worker held is reclaimed
rather than stuck — after the stale-heartbeat window it returns to `QUEUED` with a `stale_heartbeat`
event, or fails with `INTERNAL` once it is out of attempts.

**5. A reboot brings both back.**

```sh
sudo reboot
# after the host logs itself back in:
launchctl print gui/$(id -u)/com.hypit.api | grep "state = "
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/ready   # 200
```

This is the check that automatic login exists to satisfy. If `/ready` does not return 200 without
anyone touching the machine, the deployment is not accepted.

**6. No secret is exposed by the job description.**

```sh
launchctl print gui/$(id -u)/com.hypit.api    > /tmp/hypit-api-print.txt
launchctl print gui/$(id -u)/com.hypit.worker > /tmp/hypit-worker-print.txt
grep -nEi 'sk-[A-Za-z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{10}' \
  /tmp/hypit-api-print.txt /tmp/hypit-worker-print.txt
rm /tmp/hypit-api-print.txt /tmp/hypit-worker-print.txt
```

`grep` must find nothing. Run this again after any change to a plist — this is the check that
catches a credential added to the environment "temporarily".

**7. The logs are readable.**

```sh
tail -n 40 ~/hypit-work/logs/com.hypit.api.err.log
tail -n 40 ~/hypit-work/logs/com.hypit.worker.err.log
```

Neither file may contain `SQLite is an experimental feature`. If it does, the
`--disable-warning=ExperimentalWarning` argument did not survive substitution, and the error log is
on its way to becoming noise nobody reads.

## Log rotation

These paths grow without bound: launchd appends and never rotates. Add a `newsyslog.d` entry or a
periodic truncation before the host has been running long enough for it to matter.

## Uninstall

```sh
launchctl bootout gui/$(id -u)/com.hypit.worker
launchctl bootout gui/$(id -u)/com.hypit.api
rm ~/Library/LaunchAgents/com.hypit.api.plist ~/Library/LaunchAgents/com.hypit.worker.plist
```

Removing the agents stops the control plane. It does not touch the job store, the per-job workspaces
or the logs under the work root, and it does not touch the production CLI checkout.
