# Security policy

## Supported versions

Security fixes are applied to the latest version on `main` and the latest published npm release. Please upgrade before reporting an issue that may already be fixed.

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub’s private vulnerability reporting](https://github.com/7obyGit/intentum/security/advisories/new), when available. Include:

- the affected version or commit;
- a minimal reproduction or proof of concept;
- the impact and likely attack path; and
- any suggested mitigation.

Do not include live API keys, personal data, private source, or other credentials in a report.

We will acknowledge a report as soon as practical, investigate it privately, and coordinate disclosure after a fix or mitigation is available.

## Security boundaries

Intentum validates structured data but does not make model prompts safe. `impl()` and `shim()` execute generated JavaScript in the current process. Treat model-generated code and untrusted prompts as code, and isolate them in a worker or sandbox before processing untrusted input. Keep provider credentials in environment variables or a secret manager, never in source control.
