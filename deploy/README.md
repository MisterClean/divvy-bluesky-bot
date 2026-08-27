# Production deployment

Production uses a pull-based deployment. GitHub Actions builds and attests one
`linux/amd64` image after `CI / test` succeeds on `main`, then promotes that
exact digest to the GHCR `production` tag. The Lightsail host polls the tag and
runs the image by digest.

## GitHub prerequisites

Before the first release:

1. Create a `production` environment and restrict its deployment branches to
   `main`. Keep required-reviewer approval enabled for the initial rollouts.
2. Protect `main` with pull requests, required `CI / test`, resolved review
   conversations, and blocks on force pushes and branch deletion.
3. After the first package publish, make
   `ghcr.io/misterclean/divvy-bluesky-bot` public so the host can pull it
   anonymously.

The workflows do not need production secrets or an SSH key.

## Host installation

Review the files before installing them. The first installation should keep the
deployment poller disabled until a promoted image has been shadow-tested:

```bash
sudo install -o root -g root -m 0755 \
  deploy/deploy-divvy-bot /usr/local/sbin/deploy-divvy-bot
sudo install -o root -g root -m 0644 \
  deploy/divvy-bot-deploy.service /etc/systemd/system/divvy-bot-deploy.service
sudo install -o root -g root -m 0644 \
  deploy/divvy-bot-deploy.timer /etc/systemd/system/divvy-bot-deploy.timer
sudo install -o root -g root -m 0755 \
  deploy/check-divvy-bot-health /usr/local/sbin/check-divvy-bot-health
sudo install -o root -g root -m 0644 \
  deploy/divvy-bot-health.service /etc/systemd/system/divvy-bot-health.service
sudo install -o root -g root -m 0644 \
  deploy/divvy-bot-health.timer /etc/systemd/system/divvy-bot-health.timer
sudo systemctl daemon-reload
```

Manually deploy a known published digest:

```bash
sudo deploy-divvy-bot --digest sha256:<known-digest>
```

After the first deploy and rollback have both been verified:

```bash
sudo systemctl enable --now divvy-bot-deploy.timer
sudo systemctl enable --now divvy-bot-health.timer
```

The deployer:

- refuses to pull when less than 2 GiB is free;
- creates a SQLite-aware backup;
- runs the candidate against that backup with publishing disabled;
- rejects removed or incompatibly changed tables, indexes, and columns;
- pins `/etc/divvy-bot-image.env` to the exact image digest;
- runs one live bot cycle and restores the previous image pointer on failure;
- retains deployment metadata, the backup, and the current and previous image;
- always restores the regular six-hour bot timer after an interrupted deploy.

Logs are available with:

```bash
journalctl -u divvy-bot-deploy.service
journalctl -u divvy-bot.service
journalctl -u divvy-bot-health.service
```

The health timer checks every 30 minutes and fails visibly when SQLite is not
healthy, a delivery is not complete, the last successful run is more than eight
hours old, the regular bot timer is inactive, or less than 3 GiB is free beneath
the database. It deliberately does not restart Docker because this host may run
other workloads.

## Rollback

Run the `Roll back production` GitHub workflow with either a full commit SHA
from `main` or a previously published `sha256:` digest. It validates the
package image and moves the `production` tag to that exact digest. The host
poller then performs the same backup, shadow validation, pinning, and live-cycle
checks.

Do not restore a database automatically after an application failure. Restore a
saved database only as part of a deliberate maintenance rollback when a schema
change requires it.
