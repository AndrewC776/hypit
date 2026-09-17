/**
 * The whole routing layer: method plus a path pattern, and nothing else. The repo runs no HTTP
 * framework, so this is forty lines of matching rather than a dependency — and a matcher this small
 * can be read in one sitting, which matters more here than features nobody would use.
 *
 * It distinguishes "no such path" from "wrong method on a known path", because a caller that POSTs
 * to a GET route deserves a 405 with the methods that do work, not a 404 that sends them looking for
 * a typo in the path.
 */
export type RouteParams = Readonly<Record<string, string>>;

export type RouteHandler<Context> = (context: Context, params: RouteParams) => Promise<void>;

export type Route<Context> = {
  readonly method: string;
  /** `/v1/jobs/:id/logs` — a segment beginning with `:` captures that segment. */
  readonly path: string;
  readonly handler: RouteHandler<Context>;
};

export type RouteMatch<Context> =
  | { readonly kind: "matched"; readonly handler: RouteHandler<Context>; readonly params: RouteParams }
  | { readonly kind: "method-not-allowed"; readonly allowed: readonly string[] }
  | { readonly kind: "not-found" };

export type Router<Context> = {
  match(method: string, path: string): RouteMatch<Context>;
};

type Segment =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "param"; readonly name: string };

type CompiledRoute<Context> = {
  readonly method: string;
  readonly segments: readonly Segment[];
  readonly handler: RouteHandler<Context>;
};

function splitPath(path: string): readonly string[] {
  return path.split("/").filter((segment) => segment !== "");
}

function compile<Context>(route: Route<Context>): CompiledRoute<Context> {
  const segments = splitPath(route.path).map((segment): Segment =>
    segment.startsWith(":")
      ? { kind: "param", name: segment.slice(1) }
      : { kind: "literal", value: segment });
  return { method: route.method.toUpperCase(), segments, handler: route.handler };
}

/**
 * A percent-encoded segment is decoded once, here. A segment that cannot be decoded is not a match:
 * every id this API takes is plain ASCII, so an undecodable segment is either a probe or a bug, and
 * either way it addresses nothing.
 */
function bind(segments: readonly Segment[], parts: readonly string[]): RouteParams | undefined {
  if (segments.length !== parts.length) return undefined;
  const params: Record<string, string> = {};
  for (const [index, segment] of segments.entries()) {
    const part = parts[index]!;
    if (segment.kind === "literal") {
      if (segment.value !== part) return undefined;
      continue;
    }
    try {
      params[segment.name] = decodeURIComponent(part);
    } catch {
      return undefined;
    }
  }
  return params;
}

export function createRouter<Context>(routes: readonly Route<Context>[]): Router<Context> {
  const compiled = routes.map((route) => compile(route));
  return {
    match(method: string, path: string): RouteMatch<Context> {
      const parts = splitPath(path);
      const wanted = method.toUpperCase();
      const allowed: string[] = [];
      for (const route of compiled) {
        const params = bind(route.segments, parts);
        if (params === undefined) continue;
        if (route.method === wanted) return { kind: "matched", handler: route.handler, params };
        if (!allowed.includes(route.method)) allowed.push(route.method);
      }
      return allowed.length === 0 ? { kind: "not-found" } : { kind: "method-not-allowed", allowed };
    },
  };
}
