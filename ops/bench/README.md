# Resource baseline harness

Two scripts that produce the 1080x1920 numbers recorded for this deployment, so the baseline can be
re-measured rather than believed.

`make-9x16-fixture.py <chat.svml>` rewrites a copy of `examples/semantic-composition` into a
deterministic 9:16 workload: canvas 1080x1920, a 20 second timeline and eleven authored messages.
Nothing is generated and no Provider is called, which is what makes the measurement repeatable — a
number produced by a paid model call would not be comparable twice.

`worker-sweep.sh` renders that fixture at several `workers` values and reports wall time, peak
Chrome RSS, peak Chrome process count and peak load. Two details matter:

- Each run gets its own project copy. A Build whose Outputs already exist in that project's Result
  repository can be satisfied by reuse, and a reused Output times as instant rather than as a render.
- The dataRoot is shared and absolute, so every run is served by the same already-warm Runtime
  Worker and startup cost stays out of the comparison.

## Measured on the deployment host, 2026-09-17

Apple M4, 10 cores, 32 GiB, macOS 26.1, Hypit 0.1.10.

| workers | wall (3 runs) | peak Chrome RSS | Chrome processes |
| --- | --- | --- | --- |
| 1 | 37 s | 414 MiB | 5 |
| 2 | 22 s | 805 MiB | 10 |
| 4 | 16 / 21 / 26 s | 1600 MiB | 20 |
| 6 | 15 / 19 / 20 s | 2380 MiB | 30 |

`workers: 4` is the setting this supports. The gains from 1 to 2 to 4 are large and unambiguous;
4 to 6 returns 2-3 seconds, which sits inside this host's run-to-run variance, for 780 MiB and ten
more processes.

Memory is not the constraint for this workload: even six workers peak at 2.4 GiB against 32 GiB.
CPU and run-to-run variance are what bound it.

This fixture is a pure component render. It has no source-video decode, no generated A-roll, no
B-roll and no speech alignment, so a real reference-clone workload will be heavier and its knee may
sit lower. Re-measure before trusting these numbers for that case.
