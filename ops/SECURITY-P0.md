# P0 credential exposure — audit, containment, and what only you can do

The deployment host (macOS 26.1), audited read-only 2026-09-17. No secret value appears
in this document; every finding is described by name, length and first four characters only.

## Standing rule

`SECURITY_BLOCKED_EXTERNAL_INGRESS=true` until items R1 and R2 below are actually rotated by the
account owner. I cannot rotate either one — I have no OpenAI account access, and this host's
Cloudflare origin certificate is no longer authorized (`cloudflared tunnel list` returns
`unauthorized`). I have not pretended otherwise, and nothing public has been switched on.

**Current real-world exposure of the Mac is nil**: the tunnel has no public hostname ingress route.
Local `config.yml` ingress is a single catch-all `http_status:404`, and the dashboard-pushed remote
configuration contains only `warp-routing`. So the danger today is *local* credential theft, not an
open door from the internet.

## Findings

| # | Finding | Exposure | Who can fix |
| --- | --- | --- | --- |
| R1 | `CRS_OPENAI_KEY` (`sk-f…`, 67 chars) exported in `~/.zprofile:5` | was mode 644 (any local user); inherited by every child of every login shell | rotation: **you** |
| R2 | cloudflared tunnel token (`eyJh…`, 184 chars) passed as `--token` in **root LaunchDaemon** argv | visible in `ps` to any local user; in world-readable `/Library/LaunchDaemons/com.cloudflare.cloudflared.plist:13`; and printed in full by `launchctl print system/com.cloudflare.cloudflared`, **which succeeds as unprivileged `operator` with no sudo** | rotation + plist: **you** (needs sudo) |
| R3 | `ANTHROPIC_AUTH_TOKEN` (`cr_8…`, 67 chars) commented out but still plaintext in `~/.zprofile:2`, paired with a third-party relay over **plain HTTP** (`http://91.222.173.191:30031/api/`) | at rest, same file | rotation: **you** |
| R4 | The `sk-` key pattern has spread into **32 files under `~/.codex`** (29 session transcripts + `logs_2.sqlite`), 11 under `~/.cc-switch`, 4 under `~/.cache`, 20 under `~/Library/Application Support` — all in world-readable directories | any local user | **you** decide (deleting your session transcripts is your call, not mine) |
| R5 | Two cloudflared connectors serve the **same** tunnel `b9c523e9-…`: a user LaunchAgent using `credentials-file` correctly, and the root LaunchDaemon using the argv token. 8 edge connections where 4 would do. | duplication + R2 | **you** (sudo) |

Clean, for the record: the `hypit` repo has **zero** secret matches under a strict anchored regex,
both at `HEAD` and across all 1240 commits on all refs; `.gitignore` already covers `.env`, `.pem`,
`.key`, `credentials`. The 18 hits from a naive `grep -F 'sk-'` are all words like `task-`/`risk-`.

## Containment already applied (reversible, no account access needed)

```
chmod 600 ~/.zprofile              # was -rw-r--r--
chmod 600 ~/.cloudflared/config.yml # was -rw-r--r--
```

Verified afterwards that a login shell still sources the profile correctly. `~/.cloudflared/` was
already `700`, and the credentials JSON and `cert.pem` were already `600`.

Rollback if ever needed: `chmod 644 ~/.zprofile ~/.cloudflared/config.yml`.

This reduces blast radius. It does **not** fix R1–R3: those values must be treated as compromised
and rotated, because they have already been read by processes and copied into transcripts.

## What only you can do

### R1 — rotate the OpenAI key

1. Revoke the key beginning `sk-f…` at https://platform.openai.com/api-keys
2. Issue a replacement.
3. Do **not** put it back in `~/.zprofile`. Store it in the login keychain:
   ```bash
   security add-generic-password -a "$USER" -s crs-openai -w
   ```
   (`-w` with no value prompts, so the secret never enters your shell history or `ps`.)
   Read it at point of use: `security find-generic-password -s crs-openai -w`
4. Delete lines 2 and 5 from `~/.zprofile`.

Note: `@hypit/credential-store-os` already implements keychain storage under service name `hypit`,
and `security find-generic-password -s hypit` currently finds nothing — the mechanism exists and is
simply unused. New control-plane secrets should go there rather than into any dotfile.

### R2 + R5 — fix the cloudflared daemon

The cleanest fix removes the exposure and the duplication at once. The user LaunchAgent already
serves this tunnel correctly with a credentials file, so the root daemon is redundant:

```bash
sudo launchctl bootout system/com.cloudflare.cloudflared
sudo rm /Library/LaunchDaemons/com.cloudflare.cloudflared.plist
```

If you want to keep a system-level daemon instead, `cloudflared 2026.2.0` supports reading the token
from a file, so it never enters argv:

```bash
sudo install -m 600 -o root -g wheel /dev/null /etc/cloudflared/token
# write the token into that file with an editor, not via a shell command that would enter history
# then change the plist ProgramArguments from:  run --token <value>
#                                        to:    run --token-file /etc/cloudflared/token
sudo chmod 600 /Library/LaunchDaemons/com.cloudflare.cloudflared.plist
sudo launchctl kickstart -k system/com.cloudflare.cloudflared
```

Either way, **rotate the tunnel token afterwards** in the Cloudflare dashboard
(Zero Trust → Networks → Tunnels → the tunnel → Configure → refresh token), because the current one
has been readable by any local process for as long as the daemon has been running.

The origin certificate at `~/.cloudflared/cert.pem` is also no longer authorized, so re-running
`cloudflared tunnel login` will be needed before any tunnel management from this host.

### R4 — your session transcripts

32 files under `~/.codex` match the long `sk-` pattern, in world-readable directories. Deleting your
own session history is your decision, so I have not touched it. Minimum step, once R1 is rotated,
those copies become worthless; if you want them gone anyway:

```bash
chmod -R go-rwx ~/.codex ~/.cc-switch     # containment, keeps the files
```

## What the control plane does about this by construction

- No secret is ever read from a shell profile. Configuration comes from an injected environment
  object; secrets come from the keychain or a `600` file named by path, never from argv.
- The launchd plists shipped in `ops/launchd/` carry **no** secret in `ProgramArguments` or
  `EnvironmentVariables`, precisely because `launchctl print` exposes both — which is exactly how R2
  leaks today.
- Every string that leaves a process passes through `redact()`, whose tests include these two real
  shapes: an `sk-` key in a `KEY=value` shell line, and a `cloudflared … --token eyJ…` argv line.
- `GET /v1/jobs/:id/logs` additionally relativizes absolute paths, because Hypit's own execution-log
  records embed URL-encoded absolute paths that would otherwise leak the host's directory layout and
  username to every caller.
- The API binds loopback only; binding a non-loopback address is a startup error, not a warning.
