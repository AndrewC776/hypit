# Operations

Deployment material for the video-production control plane on its macOS host. Nothing here is
imported by the workspace; it is what an operator installs and runs.

| Path | Contents |
| --- | --- |
| `launchd/` | `com.hypit.api` and `com.hypit.worker` service templates, plus the install, bootstrap and acceptance procedure |

## Runtime topology

Two checkouts, one Runtime, one project copy per job.

```text
/opt/homebrew/bin/hypit  ->  ~/Documents/github/hypit          production CLI, pinned at dcce22a
                                                               main, clean, never switched

~/hypit-work/control-plane/hypit                               control-plane checkout
  services/hypit-api      127.0.0.1:8787                       accepts jobs, returns a job id
  services/hypit-worker                                        claims jobs, drives the CLI

~/hypit-work/
  baseline/hypit.runtime.json                                  one shared Runtime Profile
  baseline/.hypit/runtimes/local                               one dataRoot, one long-lived Worker
  state/jobs.sqlite3                                           job store (WAL)
  jobs/<job_id>/  input/ project/ output/ logs/                per-job workspace, mode 0700
  config/project-registry.json                                 project KEY -> absolute path
  logs/                                                        launchd stdout and stderr
```

### Two checkouts, because the CLI is a working tree

`/opt/homebrew/bin/hypit` resolves into `~/Documents/github/hypit`. That working tree **is** the
installed CLI, so checking out a branch in it changes the binary every job uses mid-flight. The
control plane is therefore developed in a separate checkout at `~/hypit-work/control-plane/hypit`
with its own `node_modules`, and nothing it does may check out a branch, stash, or otherwise disturb
the production tree. Upgrading the CLI is a deliberate, separate operation; the pin at `dcce22a` is
part of the deployment, not an accident of when it was cloned.

### One Runtime, many projects

There is a single Runtime Profile at `~/hypit-work/baseline/hypit.runtime.json`, so a single dataRoot
and a single long-lived Hypit Worker serve every job. That works because each Build captures its own
`packageRoot`: one Worker happily serves many project directories, and jobs do not each pay Runtime
startup. It also means Managed Programs are provisioned once, by `hypit runtime up` — the control
plane's worker checks `hypit programs status` at startup and refuses jobs until it reports 2/2 ready
rather than trying to provision anything per job.

### One project copy per job

The worker never builds inside a checkout. It copies the source project into
`~/hypit-work/jobs/<job_id>/project/` and points the CLI at that directory with an explicit
`--workspace`. Two consequences are load-bearing:

- Build Results land at `<job project>/.hypit/results/`, so Result isolation per job is a property of
  the layout rather than a convention. It is also what makes orphan recovery unambiguous: a job with
  a submit marker but no recorded build id lists the builds in *its own* project directory and finds
  exactly one.
- The repository working tree stays clean no matter how many jobs run.

Job workspaces are created mode `0700`, and a job may write only inside its own. The worker passes an
allowed root to the adapter and the adapter enforces containment, so a path that escapes is rejected
before anything is spawned.

### What is reachable from outside

The API binds `127.0.0.1` only; binding anything other than a loopback address is a startup error.
Public reachability is the edge Worker's concern, and it stays gated by
`SECURITY_BLOCKED_EXTERNAL_INGRESS` until the two exposed credentials have been rotated by the
account owner. No MP4 bytes ever pass through the API — outputs are reported as metadata plus a URI.

See `launchd/README.md` for installing the two services and for the acceptance checks that decide
whether a deployment is accepted.
