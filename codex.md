# Code Style
- Use ES modules (import/export), not CommonJS (require)
- Use TypeScript, not raw JavaScript

# Tooling
- Use `bun` (not npm/npx) for all package management and script running

# Workflow
- Run `bun run typecheck` (or `bunx tsc --noEmit`) before marking a task done
- Never push to main directly — always open a PR
- PR should have a clear title and description of what changed

# Code Quality
- Use `eslint` for linting
- Handle errors explicitly — avoid silent catch blocks