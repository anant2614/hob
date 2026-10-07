// Bindings wrangler cannot see: DEV_AUTH comes only from .dev.vars in local
// development and must never exist in production.
interface Env {
  readonly DEV_AUTH?: string;
}
