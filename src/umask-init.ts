/**
 * Tighten umask before ANY other module-level code runs.
 *
 * Default on `node:20-bookworm-slim` is 022 → files are created 0644.
 * The central SQLite DB and its WAL/SHM sidecars hold plaintext bearer
 * tokens; we want them 0600 from the kernel rather than racing a chmod
 * after the fact.
 *
 * Why a dedicated module instead of a top-level statement in
 * `src/index.ts`: in ES modules all `import` declarations are
 * evaluated before any subsequent statements in the module body. If
 * any imported module performs filesystem writes during its top-level
 * evaluation (a logger opening a file, a self-seeding cache, etc.),
 * those writes happen BEFORE a top-level `process.umask` call and
 * inherit the loose default. Importing this module FIRST guarantees
 * the umask is set before any other module's load-time IO. 0o077
 * strips group + world bits on every subsequent creat/open syscall.
 */
process.umask(0o077);
