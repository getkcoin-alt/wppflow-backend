# CI template

The verification workflow is saved as verify.yml.example, not an active GitHub Actions workflow. The connected GitHub OAuth credential can push application code but does not have the workflow scope needed to create workflow files.

An authorized maintainer can review and install this template as .github/workflows/verify.yml. It grants only contents: read, uses pinned official actions, and runs local tests without production credentials. Until then, local test/build results must not be presented as successful remote CI.
