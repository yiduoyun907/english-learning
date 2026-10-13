/**
 * 极简路由：支持静态路径与 `:param` 占位符，零依赖。
 * 用法：
 *   const router = createRouter();
 *   router.get('/api/wordbooks/:code/words', handler);
 *   const hit = router.match('GET', '/api/wordbooks/cet4/words'); // { handler, params }
 */
export function createRouter() {
  const routes = [];

  function add(method, pattern, handler) {
    const paramNames = [];
    const source = pattern
      .split('/')
      .map((segment) => {
        if (segment.startsWith(':')) {
          paramNames.push(segment.slice(1));
          return '([^/]+)';
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');

    routes.push({
      method,
      regex: new RegExp(`^${source}$`),
      paramNames,
      handler,
    });
  }

  return {
    get: (pattern, handler) => add('GET', pattern, handler),
    post: (pattern, handler) => add('POST', pattern, handler),
    put: (pattern, handler) => add('PUT', pattern, handler),
    delete: (pattern, handler) => add('DELETE', pattern, handler),

    /** 命中返回 { handler, params }，未命中返回 null */
    match(method, pathname) {
      for (const route of routes) {
        if (route.method !== method) continue;
        const found = route.regex.exec(pathname);
        if (!found) continue;

        const params = {};
        route.paramNames.forEach((name, index) => {
          params[name] = decodeURIComponent(found[index + 1]);
        });
        return { handler: route.handler, params };
      }
      return null;
    },
  };
}
