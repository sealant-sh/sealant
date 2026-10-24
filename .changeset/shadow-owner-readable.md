---
"@sealant/sdk": patch
---

Managed images make `/etc/shadow` readable by its owner, so a person's `sudo` works in a container
AppArmor leaves unconfined on a host whose `unix-chkpwd` profile denies PAM's helper the DAC
capabilities.
