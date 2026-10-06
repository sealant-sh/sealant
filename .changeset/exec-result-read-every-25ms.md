---
"@sealant/sdk": patch
---

`workspace.exec()` reads its run every 25 ms for the first half second, then waits twice as long
each time, from 50 ms up to 500 ms. Doubling from 25 ms read it at 25, 75, 175 and 375 ms, so an
exec that ended at 80 ms was seen at 175 ms; it is now seen within about 25 ms of ending.
