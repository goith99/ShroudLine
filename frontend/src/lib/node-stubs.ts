// Browser stub for node builtins that @arcium-hq/client imports but never
// calls on our code paths (fs is only used by its file-based module loader).
const stub = new Proxy(
  {},
  {
    get(_target, prop) {
      return () => {
        throw new Error(`node builtin not available in the browser: ${String(prop)}`);
      };
    },
  },
);

export default stub;
