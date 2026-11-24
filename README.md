# PrepLab status

This repository independently checks the three public entry points every five minutes on GitHub-hosted runners. GitHub can delay scheduled jobs. The page marks its snapshot overdue after 20 minutes.

- Website and HQ sign-in expect HTTP 200 without following redirects.
- Learner app expects HTTP 200 and an affirmative readiness result.
- Outages and recoveries are confirmed with a second probe. The state branch stores only service states and check times. The workflow retries unacknowledged alerts without logging recipients, credentials, or endpoint response bodies.
- Alerts go through the existing Resend account. Configure `STATUS_RESEND_KEY` (domain-restricted sending key), `STATUS_ALERT_FROM`, and `STATUS_ALERT_TO` (two comma-separated addresses) as GitHub Actions secrets. To verify both, dispatch the PrepLab status workflow on main with the test alert option.
- Only main runs and publishes. GitHub Pages deploys the static files under `site/`, plus the generated snapshot.
