---
"@sealant/sdk": patch
---

`workspace.exec()` reads its run back 25 ms after registering it, then waits twice as long each
time, up to 500 ms; it used to wait 500 ms before the first read. Most execs end in 100-300 ms, so
each one took at least half a second: on a Docker host, a launch that writes skills, memory and
settings into its workspace ran 20 to 125 of them in a row before its agent started. The stdout,
stderr and changes reads after the run ends go out together. `workspace.ready()` looks again after
100 ms, then twice as long each time up to 1 s, instead of every 2 s, so it answers within about a
second of the workspace becoming ready rather than up to 2 s after.
