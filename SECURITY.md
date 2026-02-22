# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in ClaudeBridge, please report it responsibly:

1. **Do NOT open a public issue.**
2. Email the maintainer directly or use [GitHub Security Advisories](https://github.com/Emqo/ClaudeBridge/security/advisories/new) to report privately.
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

We aim to acknowledge reports within 48 hours and provide a fix within 7 days for critical issues.

## Security Practices

- **No secrets in code**: `config.yaml` is gitignored. Use `config.yaml.example` as a template.
- **Access control**: User and group whitelist via `config.yaml`.
- **Per-user isolation**: Each user gets a sandboxed workspace directory.
- **Dependency management**: We use npm `overrides` to patch transitive dependency vulnerabilities when upstream packages lag behind.
- **Input validation**: Intent detection uses bounded regex patterns and low-budget Claude calls with strict output parsing.

## Dependency Vulnerabilities

We monitor dependencies via GitHub Dependabot. When a direct upgrade is not available due to transitive dependency constraints, we apply `overrides` in `package.json` to force patched versions.
